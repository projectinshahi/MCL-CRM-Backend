import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { storageConfigured } from "../../config/env.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { audit } from "../../lib/audit.ts";
import { AppError, invalid, isUniqueViolation, notFound } from "../../lib/errors.ts";
import { inBatches, sendCsv } from "../../lib/csv.ts";
import { checkFile, type FileKind } from "../../lib/files.ts";
import { todayIST } from "../../lib/format.ts";
import { blankToNull, dateOnlyStr, email, idParam, listOf, optText, pageQuery, paged, phone, searchQ, text } from "../../lib/http.ts";
import { logger } from "../../lib/logger.ts";
import { notify, type Notice } from "../../lib/notify.ts";
import { prisma } from "../../lib/prisma.ts";
import * as storage from "../../lib/storage.ts";
import { discard, formArray, multipartFiles, originalSizes, streamAttachment, uploadAll, type Upload } from "../../lib/uploads.ts";
import { updateWithHistory } from "../../lib/write.ts";
import { me, requirePermission, seesAll } from "../../middleware/auth.ts";
import { detailInclude, fromLead, leadInclude, leadScope, toLead, type LeadRow } from "../leads/routes.ts";

// Every new lead gets its customer when it is created (POST /leads, both in one transaction). Leads from before
// that can still be converted (POST /leads/:id/convert). Customers are edited here. A customer holds the
// customer's own details (who, how to reach them, company, address); a lead keeps its deal (stage, value, shipment,
// description, files), shown on the customer's page through the lead → customer link. Values are copied once, at
// conversion: editing a lead afterwards never changes its customer, and editing a customer never changes its leads.
// Customers are deactivated, never deleted (Sprint 3). Each has a CU-00001 style code from a database sequence.

const CUSTOMER_TYPES = ["direct", "b2b"] as const;

/** Customers the caller may see: not deleted, and assigned to them unless their role has "all_records". */
export const customerScope = (req: Request): Prisma.CustomerWhereInput => ({
  deletedAt: null,
  ...(seesAll(req) ? {} : { assignedUserId: me(req).id }),
});

const customerInclude = {
  source: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.CustomerInclude;
type CustomerRow = Prisma.CustomerGetPayload<{ include: typeof customerInclude }>;

const toCustomer = (c: CustomerRow) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  company: c.company,
  phone: c.phone,
  email: c.email,
  address: c.address,
  district: c.district,
  companyLocation: c.companyLocation,
  companyEmail: c.companyEmail,
  type: c.type,
  source: c.source,
  assignee: c.assignee,
  status: c.status,
  note: c.note,
  leadId: c.leadId, // the lead this customer was first created from
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export const customersRouter = Router();

const listFilters = z.object({
  q: searchQ,
  status: z.enum(["active", "inactive"]).optional(),
  type: z.enum(CUSTOMER_TYPES).optional(),
  sourceId: z.uuid().optional(),
  assignedUserId: z.uuid().optional(), // narrows within the caller's scope; never widens it
  createdFrom: dateOnlyStr.optional(), // YYYY-MM-DD, India time
});

/** The list's search and filters within the caller's scope: shared by the list and its export. */
function listWhere(req: Request, q: z.infer<typeof listFilters>): Prisma.CustomerWhereInput {
  const contains = { contains: q.q, mode: "insensitive" } as const;
  const scope = customerScope(req);
  return {
    ...scope,
    status: q.status,
    type: q.type,
    sourceId: q.sourceId,
    ...(q.assignedUserId && { AND: [{ assignedUserId: q.assignedUserId }] }),
    ...(q.createdFrom && { createdAt: { gte: new Date(`${q.createdFrom}T00:00:00+05:30`) } }),
    ...(q.q && {
      OR: [
        { code: contains },
        { name: contains },
        { company: contains },
        { phone: contains },
        { email: contains },
        { address: contains },
        { district: contains },
        { companyLocation: contains },
        { companyEmail: contains },
        { note: contains },
        { type: contains },
        { source: { name: contains } },
        { assignee: { name: contains } },
      ],
    }),
  };
}

customersRouter.get("/customers", requirePermission("customers"), async (req, res) => {
  const q = pageQuery.extend(listFilters.shape).parse(req.query);
  const scope = customerScope(req);
  const where = listWhere(req, q);
  // activeCount: every active customer the caller may see — the page's headline figure, independent of the search
  // and filters (the list's `total` is the filtered count).
  const [rows, total, activeCount] = await Promise.all([
    prisma.customer.findMany({ where, include: customerInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...paged(q) }),
    prisma.customer.count({ where }),
    prisma.customer.count({ where: { ...scope, status: "active" } }),
  ]);
  res.json({ ...listOf(rows.map(toCustomer), q, total), activeCount });
});

// The customer, plus the leads converted into it that the caller may see (deal, shipment and files stay on the
// lead and keep the lead's own access rules). `hiddenLeads` counts linked leads the caller can't open.
// The Report button: every customer the list would show for this search and these filters (all pages), as CSV.
customersRouter.get("/customers/export", requirePermission("customers"), async (req, res) => {
  const q = listFilters.parse(req.query);
  const where = listWhere(req, q);
  const header = ["Customer ID", "Name", "Company", "Phone", "Email", "Address", "District", "Company location", "Company email", "Type", "Source", "Assigned to", "Status", "Created", "Note"];
  const rows = await sendCsv(
    res,
    "customers",
    header,
    inBatches((page) => prisma.customer.findMany({ where, include: customerInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page })),
    (c) => [c.code, c.name, c.company, c.phone, c.email, c.address, c.district, c.companyLocation, c.companyEmail, c.type, c.source?.name, c.assignee?.name, c.status, todayIST(c.createdAt), c.note],
  );
  await audit(prisma, { actorId: me(req).id, action: "customers_exported", entityType: "customer", after: { rows, filters: Object.keys(q).filter((k) => q[k as keyof typeof q]) }, ip: req.ip });
});

customersRouter.get("/customers/:id", requirePermission("customers"), async (req, res) => {
  const id = idParam(req);
  const canSeeLeads = req.auth!.permissions.has("leads");
  // One round trip: the customer (the access check) and its leads and files load together; the answer is only
  // sent once the customer is known to be visible to the caller.
  const [customer, leads, linked, attachments] = await Promise.all([
    prisma.customer.findFirst({ where: { id, ...customerScope(req) }, include: customerInclude }),
    canSeeLeads
      ? prisma.lead.findMany({ where: { ...leadScope(req), customerId: id }, include: detailInclude, orderBy: [{ convertedAt: "desc" }, { id: "asc" }] })
      : [],
    prisma.lead.count({ where: { customerId: id, deletedAt: null } }),
    customerFiles(id),
  ]);
  if (!customer) throw notFound("Customer");
  res.json({ ...toCustomer(customer), attachments, leads: leads.map(toLead), hiddenLeads: linked - leads.length });
});

// .strict(): leadId, deletedAt and anything unknown are refused. Blank optional fields are cleared (null).
const updateBody = z
  .object({
    name: text(160),
    company: optText(160),
    phone: blankToNull(phone),
    email: blankToNull(email),
    address: optText(500),
    district: optText(100),
    companyLocation: optText(160),
    companyEmail: blankToNull(email),
    type: blankToNull(z.enum(CUSTOMER_TYPES, "Choose Direct or B2B")),
    sourceId: blankToNull(z.uuid("Choose a source")),
    assignedUserId: z.uuid("Select a user"),
    status: z.enum(["active", "inactive"], "Choose Active or Inactive"),
    note: optText(2000),
  })
  .partial()
  .strict();

customersRouter.patch("/customers/:id", requirePermission("customers"), async (req, res) => {
  const id = idParam(req);
  const body = updateBody.parse(req.body);
  // The customer and the source / user the edit names load together (one round trip); only changes are checked.
  const [current, source, assignee] = await Promise.all([
    prisma.customer.findFirst({ where: { id, ...customerScope(req) }, include: customerInclude }),
    body.sourceId ? prisma.leadSource.findUnique({ where: { id: body.sourceId }, select: { active: true } }) : null,
    body.assignedUserId ? prisma.user.findUnique({ where: { id: body.assignedUserId }, select: { status: true, name: true } }) : null,
  ]);
  if (!current) throw notFound("Customer");
  const newSource = body.sourceId && body.sourceId !== current.sourceId ? body.sourceId : null;
  const newAssignee = body.assignedUserId && body.assignedUserId !== current.assignedUserId ? body.assignedUserId : null;
  // Handing a customer to someone else is for roles that see every customer; others keep their own.
  if (newAssignee && !seesAll(req))
    throw new AppError(403, "FORBIDDEN", "Only roles that can see all records can reassign customers.", { assignedUserId: "You can't reassign this customer" });
  const problems: Record<string, string> = {};
  if (newSource && !source?.active) problems.sourceId = "Unknown or inactive lead source";
  if (newAssignee && assignee?.status !== "active") problems.assignedUserId = "Assign the customer to an active user";
  if (Object.keys(problems).length) throw invalid(problems);

  // The change and its audit row: one statement. Field names only: the audit log never stores contact details.
  const saved = await updateWithHistory("customers", id, {
    set: body,
    history: [{ table: "audit_logs", rows: [{ actorId: me(req).id, action: "customer_updated", entityType: "customer", entityId: id, after: { fields: Object.keys(body) }, ip: req.ip }] }],
  });
  if (!saved) throw notFound("Customer"); // deleted meanwhile
  // A new assignee hears it is theirs (administrators that it moved); administrators and the assignee hear of a
  // deactivation or reactivation; the assignee of any other change someone else made. Keys: one per save.
  const at = saved.updatedAt.getTime();
  const subject = { kind: "customer" as const, id, label: body.name ?? current.name, holderId: newAssignee ?? current.assignedUserId };
  const holder = (say: { what: string; detail: string }) => (newAssignee ? [] : [{ id: current.assignedUserId, say }]);
  const status = body.status && body.status !== current.status && { what: body.status === "inactive" ? "Customer deactivated" : "Customer reactivated", detail: `By ${me(req).name}` };
  const edited = (Object.keys(body) as (keyof typeof body)[]).some((k) => k !== "status" && k !== "assignedUserId" && body[k] !== current[k]);
  const notices: Notice[] = [];
  if (newAssignee)
    notices.push({
      key: `customer_assigned:${id}:${at}`,
      actorId: me(req).id,
      subject,
      admins: { what: "Customer reassigned", detail: `${me(req).name} assigned it to ${assignee!.name}` },
      people: [{ id: newAssignee, say: { what: "Customer assigned to you", detail: `Assigned by ${me(req).name}` } }],
    });
  if (status) notices.push({ key: `customer_status:${id}:${at}`, actorId: me(req).id, subject, admins: status, people: holder(status) });
  if (edited) notices.push({ key: `customer_updated:${id}:${at}`, actorId: me(req).id, subject, people: holder({ what: "Customer updated", detail: `${me(req).name} changed its details` }) });
  void notify(...notices);
  // Activate / Deactivate changes the status only: the customer as read, with it. Other edits are read back.
  const statusOnly = Object.keys(body).every((k) => k === "status");
  const customer = statusOnly
    ? { ...current, ...body, updatedAt: saved.updatedAt }
    : await prisma.customer.findUniqueOrThrow({ where: { id }, include: customerInclude });
  res.json(toCustomer(customer));
});

// Customers are kept for their history: deactivate (PATCH status "inactive") instead of deleting.
customersRouter.delete("/customers/:id", requirePermission("customers"), () => {
  throw new AppError(405, "CUSTOMER_DELETE_DISABLED", "Customers can't be deleted. Deactivate the customer instead.");
});

const findCustomer = async (req: Request) => {
  const customer = await prisma.customer.findFirst({ where: { id: idParam(req), ...customerScope(req) }, select: { id: true, name: true } });
  if (!customer) throw notFound("Customer"); // outside the caller's scope looks exactly like "does not exist"
  return customer;
};

/* ---------- Customer files ---------- */
// The customer's own files (private Cloudinary assets, metadata in customer_attachments), with the same checks as
// lead files: type by content, size, count. The original lead's files are not copied: they stay with the lead and
// are listed through it, under the lead's own access rules.
const attachmentSelect = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  originalSizeBytes: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
} as const;
const customerFiles = (customerId: string) =>
  prisma.customerAttachment.findMany({ where: { customerId }, select: attachmentSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

// multipart/form-data: "files" (up to 5), "ids" (JSON array, one UUID per file, chosen by the browser so a retried
// upload finds them already saved) and "originalSizes". Upload first, then one transaction saves the rows; files
// of a failed save are deleted from Cloudinary again. → 201 { items: every file of the customer }.
customersRouter.post("/customers/:id/attachments", requirePermission("customers"), multipartFiles, async (req, res) => {
  const customer = await findCustomer(req);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw invalid({ attachments: "Choose at least one file." });
  const kinds = files.map((f) => checkFile(f.originalname, f.buffer));
  const refused = kinds.find((k): k is { error: string } => "error" in k);
  if (refused) throw invalid({ attachments: refused.error });
  if (!storageConfigured) throw new AppError(503, "UPLOADS_UNAVAILABLE", "File uploads aren't set up on the server yet.");

  const sent = formArray(req, "ids");
  const ids = files.map((_, i) => z.uuid().safeParse(sent[i]).data ?? randomUUID());
  if (new Set(ids).size !== ids.length) throw invalid({ attachments: "Each file needs its own id." });
  const saved = await prisma.customerAttachment.findMany({ where: { id: { in: ids } }, select: { id: true, customerId: true } });
  if (saved.some((a) => a.customerId !== customer.id)) throw new AppError(409, "ATTACHMENT_ID_TAKEN", "These files could not be added. Choose them again and retry.");
  const done = new Set(saved.map((a) => a.id)); // a retry: these are already saved, don't upload them again
  const sizes = originalSizes(req, files);
  const uploads: Upload[] = files
    .map((file, i) => {
      const kind = kinds[i] as FileKind;
      return { attachmentId: ids[i]!, stored: storage.storedFile(`customers/${customer.id}`, ids[i]!, kind), file, mime: kind.mime, original: sizes[i]! };
    })
    .filter((u) => !done.has(u.attachmentId));
  await uploadAll(uploads);
  try {
    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.customerAttachment.createMany({
        // 1 ms apart, so files added together keep the order they were chosen in (one shared timestamp would not).
        data: uploads.map((u, i) => ({
          createdAt: new Date(now + i),
          id: u.attachmentId,
          customerId: customer.id,
          publicId: u.stored.publicId,
          resourceType: u.stored.resourceType,
          fileName: u.file.originalname,
          mimeType: u.mime,
          sizeBytes: u.file.size,
          originalSizeBytes: u.original,
          uploadedById: me(req).id,
        })),
      });
      if (uploads.length)
        await audit(tx, { actorId: me(req).id, action: "customer_files_added", entityType: "customer", entityId: customer.id, after: { files: uploads.length }, ip: req.ip });
    });
  } catch (err) {
    // Saved meanwhile by a concurrent retry of the same upload: those rows use these files, so they stay.
    if (!isUniqueViolation(err)) {
      await discard(uploads);
      throw err;
    }
  }
  res.status(201).json({ items: await customerFiles(customer.id) });
});

customersRouter.get("/customers/:id/attachments/:attachmentId", requirePermission("customers"), async (req, res) => {
  const customer = await findCustomer(req);
  const attachmentId = z.uuid().safeParse(req.params.attachmentId);
  const a = attachmentId.success && (await prisma.customerAttachment.findFirst({ where: { id: attachmentId.data, customerId: customer.id } }));
  if (!a) throw notFound("Attachment");
  await streamAttachment(res, a);
});

// Removes a customer file: the row (with an audit entry) first, then the stored file; a file Cloudinary fails to
// delete is logged for clean-up and never shown again.
customersRouter.delete("/customers/:id/attachments/:attachmentId", requirePermission("customers"), async (req, res) => {
  const customer = await findCustomer(req);
  const attachmentId = z.uuid().safeParse(req.params.attachmentId);
  const a = attachmentId.success && (await prisma.customerAttachment.findFirst({ where: { id: attachmentId.data, customerId: customer.id } }));
  if (!a) throw notFound("Attachment");
  await prisma.$transaction([
    prisma.customerAttachment.delete({ where: { id: a.id } }),
    audit(prisma, { actorId: me(req).id, action: "customer_file_removed", entityType: "customer", entityId: customer.id, before: { fileName: a.fileName }, ip: req.ip }),
  ]);
  await storage.remove({ publicId: a.publicId, resourceType: a.resourceType as FileKind["resourceType"] }).catch((e) =>
    logger.warn({ publicId: a.publicId, reason: String(e?.message ?? e) }, "could not delete a removed customer file from Cloudinary"),
  );
  res.status(204).end();
});

/* ---------- Customer activity entries (Initial / Follow Up / Call) ---------- */
const ACTIVITY_TYPES = ["initial", "follow_up", "call"] as const;
const activityInclude = { actor: { select: { id: true, name: true } } } as const;
const toActivity = (a: Prisma.CustomerActivityGetPayload<{ include: typeof activityInclude }>) => ({
  id: a.id,
  type: a.type,
  occurredAt: a.occurredAt,
  notes: a.notes,
  actor: a.actor,
  createdAt: a.createdAt,
});
const activityBody = z
  .object({
    id: z.uuid().optional(), // chosen by the form: saving the same entry again (a retry) doesn't record it twice
    type: z.enum(ACTIVITY_TYPES, "Choose Initial, Follow Up or Call"),
    occurredAt: z.iso.datetime({ offset: true, message: "Use an ISO 8601 date-time with a time zone" }),
    notes: optText(2000),
  })
  .strict();

customersRouter.get("/customers/:id/activities", requirePermission("customers"), async (req, res) => {
  const q = pageQuery.parse(req.query);
  const where = { customerId: idParam(req) };
  // The access check runs alongside the reads (one round trip); nothing is sent unless it passes.
  const [, rows, total] = await Promise.all([
    findCustomer(req),
    prisma.customerActivity.findMany({ where, include: activityInclude, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "asc" }], ...paged(q) }),
    prisma.customerActivity.count({ where }),
  ]);
  res.json(listOf(rows.map(toActivity), q, total));
});

customersRouter.post("/customers/:id/activities", requirePermission("customers"), async (req, res) => {
  const customer = await findCustomer(req);
  const body = activityBody.parse(req.body);
  // A record of something that happened (planned contact belongs in Follow-ups): not in the future.
  if (new Date(body.occurredAt).getTime() > Date.now() + 5 * 60_000) throw invalid({ occurredAt: "Can't be in the future" });
  const id = body.id ?? randomUUID();
  const replay = async () => {
    const existing = await prisma.customerActivity.findUnique({ where: { id }, include: activityInclude });
    if (existing && existing.customerId === customer.id && existing.actorId === me(req).id) return existing;
    if (existing) throw new AppError(409, "ACTIVITY_ID_TAKEN", "This entry could not be saved. Close the form and try again.");
    return null;
  };
  const again = await replay();
  if (again) return void res.status(200).json(toActivity(again));
  try {
    const created = await prisma.customerActivity.create({
      data: { id, customerId: customer.id, type: body.type, occurredAt: new Date(body.occurredAt), notes: body.notes ?? null, actorId: me(req).id },
      include: activityInclude,
    });
    res.status(201).json(toActivity(created));
  } catch (err) {
    const raced = isUniqueViolation(err) && (await replay());
    if (!raced) throw err;
    res.status(200).json(toActivity(raced));
  }
});

/* ---------- Lead → customer conversion ---------- */
// Needs both Leads and Customers access, and the lead must be within the caller's lead scope.

/**
 * Existing customers that may be the same as the lead's: same email (contact or company), same phone, or same
 * company name. None of these is treated as a unique identity — the user decides. Only customers within the
 * caller's scope are considered: others are neither shown nor counted.
 */
async function possibleMatches(req: Request, l: LeadRow) {
  const emails = [...new Set([l.contactEmail, l.companyEmail].filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
  const company = l.companyName?.trim().toLowerCase();
  const or: Prisma.CustomerWhereInput[] = [
    ...emails.flatMap((e): Prisma.CustomerWhereInput[] => [{ email: { equals: e, mode: "insensitive" } }, { companyEmail: { equals: e, mode: "insensitive" } }]),
    ...(l.contactPhone ? [{ phone: l.contactPhone }] : []),
    ...(company ? [{ company: { equals: company, mode: "insensitive" as const } }] : []),
  ];
  if (!or.length) return { matches: [] };
  const rows = await prisma.customer.findMany({
    where: { OR: or, ...customerScope(req) },
    include: customerInclude,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 10,
  });
  const matchedOn = (c: CustomerRow) => [
    ...([c.email, c.companyEmail].some((e) => e && emails.includes(e.toLowerCase())) ? ["email"] : []),
    ...(l.contactPhone && c.phone === l.contactPhone ? ["phone"] : []),
    ...(company && c.company?.trim().toLowerCase() === company ? ["company"] : []),
  ];
  return { matches: rows.map((c) => ({ ...toCustomer(c), matchedOn: matchedOn(c) })) };
}

async function findConvertible(req: Request, id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, ...leadScope(req) }, include: leadInclude });
  if (!lead) throw notFound("Lead"); // outside the caller's scope looks exactly like "does not exist"
  return lead;
}

/** The stage a conversion moves the lead to: the first "won" stage, unless the lead is already in one. */
const wonStage = (l: LeadRow) =>
  l.status.isWon ? null : prisma.leadStatus.findFirst({ where: { isWon: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } });

/** A lead that is already converted: its customer, if the caller may see it. */
async function convertedResult(req: Request, l: LeadRow) {
  const customer = await prisma.customer.findFirst({ where: { id: l.customerId!, ...customerScope(req) }, include: customerInclude });
  if (customer) return { created: false, alreadyConverted: true, customer: toCustomer(customer), lead: toLead(l) };
  if (l.customer?.deletedAt) throw new AppError(409, "CUSTOMER_DELETED", "This lead was already converted, but its customer has since been deleted.");
  throw new AppError(409, "ALREADY_CONVERTED", "This lead was already converted to a customer assigned to someone else.");
}

customersRouter.get("/leads/:id/conversion", requirePermission("leads"), requirePermission("customers"), async (req, res) => {
  const lead = await findConvertible(req, idParam(req));
  if (lead.customerId) return void res.json(await convertedResult(req, lead));
  const proposed = fromLead(lead);
  const [{ matches }, moveTo] = await Promise.all([possibleMatches(req, lead), wonStage(lead)]);
  res.json({
    alreadyConverted: false,
    customer: { ...proposed, source: lead.source, assignee: lead.owner },
    missing: proposed.name ? [] : ["name"],
    matches,
    moveTo,
  });
});

class LeadTaken extends Error {}

// Body: {} or { createNew: true } creates the customer from the lead; { customerId } links the lead to that existing
// customer instead (its details are left exactly as they are). A first attempt that finds possible matches is
// refused (409 POSSIBLE_DUPLICATE) until the user picks one or confirms createNew.
// Exactly once: the lead is linked with a conditional update (customer_id IS NULL) inside the same transaction that
// creates the customer, and customers.lead_id is unique — a repeat or concurrent request gets the existing customer.
customersRouter.post("/leads/:id/convert", requirePermission("leads"), requirePermission("customers"), async (req, res) => {
  const id = idParam(req);
  const body = z.object({ customerId: z.uuid("Choose a customer").optional(), createNew: z.boolean().optional() }).strict().parse(req.body ?? {});
  const lead = await findConvertible(req, id);
  if (lead.customerId) return void res.json(await convertedResult(req, lead));

  let existing: CustomerRow | null = null;
  let create: Prisma.CustomerUncheckedCreateInput | null = null;
  if (body.customerId) {
    existing = await prisma.customer.findFirst({ where: { id: body.customerId, ...customerScope(req) }, include: customerInclude });
    if (!existing) throw notFound("Customer");
  } else {
    const { name, ...rest } = fromLead(lead);
    if (!name)
      throw new AppError(422, "CUSTOMER_NAME_MISSING", "Add a contact name or a company name to this lead before converting it.", {
        name: "The lead has no contact name or company name",
      });
    create = { ...rest, name, leadId: id };
    if (!body.createNew) {
      const m = await possibleMatches(req, lead);
      if (m.matches.length)
        throw new AppError(409, "POSSIBLE_DUPLICATE", "Existing customers may be this lead's customer. Choose one of them, or confirm that this is a new customer.");
    }
  }
  const moveTo = await wonStage(lead);

  try {
    const { customer, next } = await prisma.$transaction(async (tx) => {
      const customer = existing ?? (await tx.customer.create({ data: create!, include: customerInclude }));
      const { count } = await tx.lead.updateMany({
        where: { id, customerId: null, deletedAt: null },
        data: { customerId: customer.id, convertedAt: new Date(), ...(moveTo && { statusId: moveTo.id }), version: { increment: 1 } },
      });
      if (count !== 1) throw new LeadTaken(); // converted (or deleted) by someone else meanwhile: the new customer is rolled back too
      const actor = { leadId: id, actorId: me(req).id };
      await tx.leadActivity.createMany({
        data: [
          ...(moveTo ? [{ ...actor, type: "status_changed", message: `Status changed from ${lead.status.name} to ${moveTo.name}` }] : []),
          {
            ...actor,
            type: "converted",
            message: existing ? `Linked to existing customer ${customer.name}` : `Converted to customer ${customer.name}`,
            data: { customerId: customer.id },
          },
        ],
      });
      await audit(tx, {
        actorId: me(req).id,
        action: "lead_converted",
        entityType: "lead",
        entityId: id,
        before: { statusId: lead.statusId },
        after: { customerId: customer.id, created: !existing, statusId: moveTo?.id ?? lead.statusId },
        ip: req.ip,
      });
      return { customer, next: await tx.lead.findUniqueOrThrow({ where: { id }, include: leadInclude }) };
    });
    // Only the request that converted it gets here (a repeat answers from convertedResult), so this is sent once.
    const say = { what: existing ? "Lead linked to a customer" : "Lead converted to a customer", detail: `By ${me(req).name}` };
    void notify({ key: `lead_converted:${id}`, actorId: me(req).id, subject: { kind: "lead", id, label: lead.title, holderId: lead.ownerId }, admins: say, people: [{ id: lead.ownerId, say }] });
    res.status(existing ? 200 : 201).json({ created: !existing, alreadyConverted: false, customer: toCustomer(customer), lead: toLead(next) });
  } catch (err) {
    if (!(err instanceof LeadTaken) && !isUniqueViolation(err)) throw err;
    const now = await findConvertible(req, id); // 404 if it was deleted meanwhile
    if (!now.customerId) throw err;
    res.json(await convertedResult(req, now));
  }
});
