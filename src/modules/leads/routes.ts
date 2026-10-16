import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { storageConfigured } from "../../config/env.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { AppError, invalid, isUniqueViolation, notFound } from "../../lib/errors.ts";
import { checkFile, type FileKind } from "../../lib/files.ts";
import { toMoney } from "../../lib/format.ts";
import { blankToNull, email, idParam, listOf, money, optText, pageQuery, paged, phone, searchQ, text, weightKg } from "../../lib/http.ts";
import { prisma } from "../../lib/prisma.ts";
import * as storage from "../../lib/storage.ts";
import { discard, multipartFiles, originalSizes, streamAttachment, uploadAll, type Upload } from "../../lib/uploads.ts";
import { insertRows, updateWithHistory } from "../../lib/write.ts";
import { me, requirePermission, seesAll } from "../../middleware/auth.ts";

const PRIORITIES = ["low", "medium", "high"] as const;
const SHIPMENT_TYPES = ["air", "water"] as const;

/** Leads the caller may see: not deleted, and owned by them unless their role has "all_records". */
export const leadScope = (req: Request): Prisma.LeadWhereInput => ({
  deletedAt: null,
  ...(seesAll(req) ? {} : { ownerId: me(req).id }),
});

export const leadInclude = {
  source: { select: { id: true, name: true } },
  status: { select: { id: true, name: true, isWon: true, isLost: true } },
  owner: { select: { id: true, name: true } },
  customer: { select: { id: true, code: true, name: true, deletedAt: true } }, // set once the lead is converted
} satisfies Prisma.LeadInclude;
// The detail view (and a create's reply) also lists the lead's files; lists and the pipeline never load them.
const attachmentSelect = { id: true, fileName: true, mimeType: true, sizeBytes: true, originalSizeBytes: true, createdAt: true } as const;
export const detailInclude = { ...leadInclude, attachments: { select: attachmentSelect, orderBy: { createdAt: "asc" } } } satisfies Prisma.LeadInclude;
export type LeadRow = Prisma.LeadGetPayload<{ include: typeof leadInclude }> & Partial<Prisma.LeadGetPayload<{ include: typeof detailInclude }>>;

export const toLead = (l: LeadRow) => ({
  id: l.id,
  title: l.title,
  description: l.description,
  address: l.address,
  district: l.district,
  contact: { name: l.contactName, phone: l.contactPhone, email: l.contactEmail },
  customerType: l.customerType,
  company: { name: l.companyName, location: l.companyLocation, email: l.companyEmail },
  source: l.source,
  status: l.status,
  priority: l.priority,
  expectedValue: toMoney(l.expectedValue),
  paymentStatus: l.paymentStatus,
  owner: l.owner,
  shipment: {
    destinationCountry: l.shipmentDestinationCountry,
    commodity: l.shipmentCommodity,
    shipmentType: l.shipmentType,
    weightKg: l.shipmentWeightKg == null ? null : Number(l.shipmentWeightKg.toFixed(3)),
    volume: l.shipmentVolume,
    pickupLocation: l.shipmentPickupLocation,
    deliveryLocation: l.shipmentDeliveryLocation,
  },
  // The customer this lead was converted into; `deleted` when that customer has since been deleted.
  customer: l.customer && { id: l.customer.id, code: l.customer.code, name: l.customer.name, deleted: l.customer.deletedAt !== null },
  convertedAt: l.convertedAt,
  version: l.version,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
  ...(l.attachments && { attachments: l.attachments }),
});

/**
 * The customer a lead becomes: only what the lead holds, nothing invented. The customer's name is the contact's
 * name, or the company's when no contact was recorded. Deliberately not copied: the description (an internal deal
 * note, which Customers-only users must not read), and the deal itself — stage, priority, value, payment status,
 * shipment details and files — which stay on the lead and appear on the customer's page through the link.
 */
export function fromLead(l: Partial<Prisma.LeadGetPayload<object>>) {
  return {
    name: l.contactName?.trim() || l.companyName?.trim() || null,
    company: l.companyName ?? null,
    phone: l.contactPhone ?? null,
    email: l.contactEmail ?? null,
    address: l.address ?? null,
    district: l.district ?? null,
    companyLocation: l.companyLocation ?? null,
    companyEmail: l.companyEmail ?? null,
    type: l.customerType ?? null,
    sourceId: l.sourceId ?? null,
    assignedUserId: l.ownerId ?? null, // the salesperson keeps the customer (and sees it without "All records")
  };
}

// .strict() everywhere: unknown keys (paymentStatus, createdById, deletedAt…) are rejected, not silently stored.
const fields = {
  title: text(200),
  description: optText(2000),
  address: optText(500),
  district: optText(100),
  contact: z.object({ name: optText(120), phone: blankToNull(phone), email: blankToNull(email) }).strict().optional(),
  customerType: blankToNull(z.enum(["direct", "b2b"])),
  company: z.object({ name: optText(160), location: optText(160), email: blankToNull(email) }).strict().optional(),
  sourceId: blankToNull(z.uuid()),
  ownerId: z.uuid().optional(),
  statusId: z.uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  expectedValue: blankToNull(money),
  shipment: z
    .object({
      destinationCountry: optText(80),
      commodity: optText(120),
      // "Air"/"AIR" from older callers are accepted and stored lower-case, like the other enums.
      shipmentType: blankToNull(z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(SHIPMENT_TYPES, "Choose Air or Water"))),
      weightKg: blankToNull(weightKg),
      volume: optText(60),
      pickupLocation: optText(200),
      deliveryLocation: optText(200),
    })
    .strict()
    .optional(),
};
// id: chosen by the form, so a resubmit or a retry after a lost response finds the lead already saved (idempotent).
const createBody = z.object({ ...fields, id: z.uuid().optional() }).strict();
const updateBody = z.object({ ...fields, title: fields.title.optional(), version: z.number().int().min(1).optional() }).strict();
type LeadInput = z.infer<typeof updateBody>;

// API shape → columns. undefined = leave unchanged, null = clear.
function toColumns(b: LeadInput) {
  const cols = {
    title: b.title,
    description: b.description,
    address: b.address,
    district: b.district,
    customerType: b.customerType,
    sourceId: b.sourceId,
    ownerId: b.ownerId,
    statusId: b.statusId,
    priority: b.priority,
    expectedValue: b.expectedValue,
    contactName: b.contact?.name,
    contactPhone: b.contact?.phone,
    contactEmail: b.contact?.email,
    companyName: b.company?.name,
    companyLocation: b.company?.location,
    companyEmail: b.company?.email,
    shipmentDestinationCountry: b.shipment?.destinationCountry,
    shipmentCommodity: b.shipment?.commodity,
    shipmentType: b.shipment?.shipmentType,
    shipmentWeightKg: b.shipment?.weightKg,
    shipmentVolume: b.shipment?.volume,
    shipmentPickupLocation: b.shipment?.pickupLocation,
    shipmentDeliveryLocation: b.shipment?.deliveryLocation,
  };
  return Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== undefined)) as Prisma.LeadUncheckedUpdateInput;
}

type Refs = { sourceId?: string | null; statusId?: string; ownerId?: string };

/** The references named, loaded in parallel (one round trip); the status and owner as a lead includes them. */
async function loadReferences(refs: Refs) {
  const [source, status, owner] = await Promise.all([
    refs.sourceId ? prisma.leadSource.findUnique({ where: { id: refs.sourceId }, select: { active: true } }) : null,
    refs.statusId ? prisma.leadStatus.findUnique({ where: { id: refs.statusId }, select: leadInclude.status.select }) : null,
    refs.ownerId ? prisma.user.findUnique({ where: { id: refs.ownerId }, select: { id: true, name: true, status: true } }) : null,
  ]);
  return { source, status, owner };
}

/** Refuses the references in `refs` that are unknown or inactive; pass only those being set or changed. */
function refuseBadReferences(refs: Refs, found: Awaited<ReturnType<typeof loadReferences>>) {
  const problems: Record<string, string> = {};
  if (refs.sourceId && !found.source?.active) problems.sourceId = "Unknown or inactive lead source";
  if (refs.statusId && !found.status) problems.statusId = "Unknown lead status";
  if (refs.ownerId && found.owner?.status !== "active") problems.ownerId = "Owner must be an active user";
  if (Object.keys(problems).length) throw invalid(problems);
}

/** Validates only the references being set or changed (an existing lead may keep a since-deactivated source). */
async function checkReferences(refs: Refs) {
  refuseBadReferences(refs, await loadReferences(refs));
}

const stale = () => new AppError(409, "STALE_VERSION", "This lead was changed by someone else. Reload it and try again.");

async function findLead(req: Request, id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, ...leadScope(req) }, include: leadInclude });
  if (!lead) throw notFound("Lead"); // outside the caller's scope looks exactly like "does not exist"
  return lead;
}

const listFilters = z.object({
  q: searchQ,
  sourceId: z.uuid().optional(),
  statusId: z.uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
});

function filterWhere(req: Request, f: z.infer<typeof listFilters>): Prisma.LeadWhereInput {
  const contains = { contains: f.q, mode: "insensitive" } as const;
  const priority = PRIORITIES.find((p) => p === f.q?.toLowerCase());
  return {
    ...leadScope(req),
    sourceId: f.sourceId,
    statusId: f.statusId,
    priority: f.priority,
    ...(f.q && {
      OR: [
        { title: contains },
        { contactName: contains },
        { companyName: contains },
        { source: { name: contains } },
        { status: { name: contains } },
        { owner: { name: contains } },
        ...(priority ? [{ priority }] : []),
      ],
    }),
  };
}

const SORTS = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  value_desc: { expectedValue: { sort: "desc", nulls: "last" } },
  value_asc: { expectedValue: { sort: "asc", nulls: "last" } },
  title: { title: "asc" },
} satisfies Record<string, Prisma.LeadOrderByWithRelationInput>;

export const leadsRouter = Router();

leadsRouter.get("/leads", requirePermission("leads"), async (req, res) => {
  const q = pageQuery.extend(listFilters.shape).extend({ sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS]).default("newest") }).parse(req.query);
  const where = filterWhere(req, q);
  const [rows, total] = await Promise.all([
    prisma.lead.findMany({ where, include: leadInclude, orderBy: [SORTS[q.sort], { id: "asc" }], ...paged(q) }),
    prisma.lead.count({ where }),
  ]);
  res.json(listOf(rows.map(toLead), q, total));
});

leadsRouter.get("/leads/pipeline", requirePermission("leads"), async (req, res) => {
  const q = listFilters.omit({ statusId: true }).extend({ perColumn: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
  const where = filterWhere(req, q);
  // One round trip: each stage comes with its newest `perColumn` cards (joined in SQL, limited per stage) while the
  // totals run alongside. Stages first and then a query per column took two sequential round trips (~0.3 s each on Neon).
  const [statuses, totals] = await Promise.all([
    prisma.leadStatus.findMany({
      relationLoadStrategy: "join",
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        isWon: true,
        isLost: true,
        leads: { where, include: leadInclude, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: q.perColumn },
      },
    }),
    prisma.lead.groupBy({ by: ["statusId"], where, _count: { _all: true }, _sum: { expectedValue: true } }),
  ]);
  const columns = statuses.map(({ leads, ...status }) => {
    const t = totals.find((g) => g.statusId === status.id);
    return { status, count: t?._count._all ?? 0, totalValue: toMoney(t?._sum.expectedValue ?? null) ?? 0, items: leads.map(toLead) };
  });
  res.json({ columns });
});

// ---------- Create, with optional attachments ----------
// JSON as before, or multipart/form-data: "lead" (the same JSON), "files" (up to MAX_FILES) and "originalSizes"
// (JSON array: a file's size before in-browser compression, or null). Order of work, so a failure leaves nothing
// half-done: check every field and file → upload the files → one transaction saves the lead and its attachment rows.
// A PostgreSQL rollback cannot undo an upload, so files of a failed save are deleted from Cloudinary again.
function formBody(req: Request) {
  if (!req.is("multipart/form-data")) return req.body;
  try {
    return JSON.parse(String(req.body?.lead ?? ""));
  } catch {
    throw new AppError(400, "MALFORMED_JSON", "Request body is not valid JSON.");
  }
}

/** The lead a repeated create already saved, if it is the caller's; an id used by anyone else is refused. */
async function alreadyCreated(req: Request, id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, createdById: me(req).id, ...leadScope(req) }, include: detailInclude });
  if (lead) return lead;
  if (await prisma.lead.count({ where: { id } })) throw new AppError(409, "LEAD_ID_TAKEN", "This lead could not be created. Close the form and try again.");
  return null;
}

leadsRouter.post("/leads", requirePermission("leads"), multipartFiles, async (req, res) => {
  const body = createBody.parse(formBody(req));
  // The lead's customer is named after its contact, or its company (never an invented name), so one is needed.
  if (!body.contact?.name && !body.company?.name) throw invalid({ "contact.name": "Enter the customer's name, or a company name for a B2B lead" });
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  // Every file is checked (by content, not just its name) before anything is uploaded or saved.
  const kinds = files.map((f) => checkFile(f.originalname, f.buffer));
  const refused = kinds.find((k): k is { error: string } => "error" in k);
  if (refused) throw invalid({ attachments: refused.error });
  if (files.length && !storageConfigured)
    throw new AppError(503, "UPLOADS_UNAVAILABLE", "File uploads aren't set up on the server yet. Remove the files to create the lead without them.");

  const [, firstStatus, done] = await Promise.all([
    checkReferences({ sourceId: body.sourceId, statusId: body.statusId, ownerId: body.ownerId }),
    body.statusId ? null : prisma.leadStatus.findFirst({ orderBy: { sortOrder: "asc" }, select: { id: true } }),
    body.id && files.length ? alreadyCreated(req, body.id) : null, // checked first so a retry does not upload again
  ]);
  if (done) return void res.status(200).json(toLead(done));
  const statusId = body.statusId ?? firstStatus?.id;
  if (!statusId) throw new AppError(409, "NO_STATUSES", "Add a lead status in Settings before creating leads.");

  const id = body.id ?? randomUUID();
  const sizes = originalSizes(req, files);
  const uploads: Upload[] = files.map((file, i) => {
    const kind = kinds[i] as FileKind;
    const attachmentId = randomUUID();
    return { attachmentId, stored: storage.storedFile(`leads/${id}`, attachmentId, kind), file, mime: kind.mime, original: sizes[i]! };
  });
  await uploadAll(uploads);

  // The lead, its files' rows, its customer and the lead's first activity entries are ONE statement: all saved or
  // none (like a transaction, and the links between them are checked at its end), in a single round trip. The
  // Prisma transaction it replaces took five (begin, insert, read, history, commit); the reply is read after it.
  // The customer: linked both ways (customers.lead_id is unique, so a lead can never get a second one), its code
  // (CU-00001…) from the customer_code sequence, named after the contact or company. It belongs to the lead's
  // owner, like a converted one; the creator needs no Customers access for it to be made.
  const filedAt = Date.now();
  const now = new Date(filedAt);
  const ownerId = body.ownerId ?? me(req).id; // defaults to the creator so the lead stays visible to them
  const customerId = randomUUID();
  const columns = toColumns(body);
  const { name, ...c } = fromLead({ ...(columns as Partial<Prisma.LeadGetPayload<object>>), ownerId });
  const leadRow = { ...columns, id, statusId, ownerId, createdBy: me(req).id, customerId, createdAt: now, updatedAt: now };
  // 1 ms apart, so the files keep the order they were attached in (one shared timestamp would not).
  const fileRows = uploads.map((u, i) => ({
    id: u.attachmentId,
    leadId: id,
    publicId: u.stored.publicId,
    resourceType: u.stored.resourceType,
    fileName: u.file.originalname,
    mimeType: u.mime,
    sizeBytes: u.file.size,
    originalSizeBytes: u.original,
    uploadedBy: me(req).id,
    createdAt: new Date(filedAt + i),
  }));
  const withFiles = uploads.length ? ` with ${uploads.length} file${uploads.length === 1 ? "" : "s"}` : "";
  try {
    await prisma.$queryRaw`
      WITH l AS (${insertRows("leads", [leadRow])}),
      ${fileRows.length ? Prisma.sql`f AS (${insertRows("lead_attachments", fileRows)}),` : Prisma.empty}
      c AS (
        INSERT INTO customers (id, name, company, phone, email, address, district, company_location, company_email, type, source_id, assigned_user_id, lead_id, created_at, updated_at)
        VALUES (${customerId}::uuid, ${name}, ${c.company}, ${c.phone}, ${c.email}, ${c.address}, ${c.district}, ${c.companyLocation}, ${c.companyEmail}, ${c.type},
                ${c.sourceId}::uuid, ${c.assignedUserId}::uuid, ${id}::uuid, ${now}::timestamptz, ${now}::timestamptz)
        RETURNING code
      ), h AS (
        INSERT INTO lead_activities (id, lead_id, actor_id, type, message, data, created_at)
        SELECT ${randomUUID()}::uuid, ${id}::uuid, ${me(req).id}::uuid, 'created', ${`Lead created by ${me(req).name}${withFiles}`}, NULL::jsonb, ${now}::timestamptz FROM c
        UNION ALL -- 1 ms later, so the activity list (newest first) shows it above "Lead created"
        SELECT ${randomUUID()}::uuid, ${id}::uuid, ${me(req).id}::uuid, 'customer_created', 'Customer ' || code || ' created', ${JSON.stringify({ customerId })}::jsonb, ${new Date(filedAt + 1)}::timestamptz FROM c
      )
      SELECT code FROM c`;
  } catch (err) {
    await discard(uploads); // nothing was saved; the files must go too
    const replay = isUniqueViolation(err) && (await alreadyCreated(req, id));
    if (replay) return void res.status(200).json(toLead(replay));
    throw err;
  }
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, include: detailInclude, relationLoadStrategy: "join" });
  res.status(201).json(toLead(lead));
});

leadsRouter.get("/leads/:id", requirePermission("leads"), async (req, res) => {
  const lead = await prisma.lead.findFirst({ where: { id: idParam(req), ...leadScope(req) }, include: detailInclude });
  if (!lead) throw notFound("Lead");
  res.json(toLead(lead));
});

// The file itself, streamed by the API with its original name: only for callers who can see the lead, and the
// private Cloudinary link (valid for a minute) never leaves the server.
leadsRouter.get("/leads/:id/attachments/:attachmentId", requirePermission("leads"), async (req, res) => {
  const attachmentId = z.uuid().safeParse(req.params.attachmentId);
  const a =
    attachmentId.success &&
    (await prisma.leadAttachment.findFirst({ where: { id: attachmentId.data, lead: { id: idParam(req), ...leadScope(req) } } }));
  if (!a) throw notFound("Attachment");
  await streamAttachment(res, a);
});

// A pipeline move is { statusId, version }: three round trips in all (session, lead + new stage, the write).
leadsRouter.patch("/leads/:id", requirePermission("leads"), async (req, res) => {
  const id = idParam(req);
  const { version, ...body } = updateBody.parse(req.body);
  // The lead and the references the edit names load together; only those it changes are then checked.
  const [current, found] = await Promise.all([findLead(req, id), loadReferences(body)]);
  if (version !== undefined && version !== current.version) throw stale();
  const changed = {
    sourceId: body.sourceId !== current.sourceId ? body.sourceId : undefined,
    statusId: body.statusId !== current.statusId ? body.statusId : undefined,
    ownerId: body.ownerId !== current.ownerId ? body.ownerId : undefined,
  };
  refuseBadReferences(changed, found);
  const columns = toColumns(body);

  const activities: Prisma.LeadActivityCreateManyInput[] = [];
  const actor = { leadId: id, actorId: me(req).id };
  if (changed.statusId) activities.push({ ...actor, type: "status_changed", message: `Status changed from ${current.status.name} to ${found.status!.name}` });
  if (changed.ownerId) activities.push({ ...actor, type: "assigned", message: `Assigned to ${found.owner!.name}` });
  const other = Object.keys(columns).filter((k) => k !== "statusId" && k !== "ownerId");
  if (other.length) activities.push({ ...actor, type: "updated", message: "Lead details updated", data: { fields: other } });
  const audits = changed.ownerId
    ? [{ actorId: me(req).id, action: "lead_assigned", entityType: "lead", entityId: id, before: { ownerId: current.ownerId }, after: { ownerId: changed.ownerId }, ip: req.ip }]
    : [];

  // One statement; optimistic lock: the row must still be at the version read above.
  const saved = await updateWithHistory("leads", id, {
    version: current.version,
    set: columns,
    history: [{ table: "lead_activities", rows: activities }, { table: "audit_logs", rows: audits }],
  });
  if (!saved) throw stale();
  // Only the stage and/or owner changed (a pipeline move): that is the lead as read, plus what changed — exact,
  // since the version check proves nothing else changed in between. Any other edit is read back (one round trip).
  if (!other.length) {
    const next = { ...current, updatedAt: saved.updatedAt, version: saved.version!, statusId: body.statusId ?? current.statusId, status: found.status ?? current.status };
    return void res.json(toLead(changed.ownerId ? { ...next, ownerId: changed.ownerId, owner: { id: found.owner!.id, name: found.owner!.name } } : next));
  }
  res.json(toLead(await prisma.lead.findUniqueOrThrow({ where: { id }, include: leadInclude })));
});

// Soft delete: follow-ups, activity and any linked customer are kept.
leadsRouter.delete("/leads/:id", requirePermission("leads"), async (req, res) => {
  const id = idParam(req);
  const current = await findLead(req, id);
  const saved = await updateWithHistory("leads", id, {
    set: { deletedAt: new Date() },
    history: [
      { table: "lead_activities", rows: [{ leadId: id, actorId: me(req).id, type: "deleted", message: `Lead deleted by ${me(req).name}` }] },
      { table: "audit_logs", rows: [{ actorId: me(req).id, action: "lead_deleted", entityType: "lead", entityId: id, before: { title: current.title }, ip: req.ip }] },
    ],
  });
  if (!saved) throw notFound("Lead"); // deleted by someone else meanwhile
  res.status(204).end();
});

leadsRouter.post("/leads/:id/assign", requirePermission("leads"), async (req, res) => {
  const id = idParam(req);
  const { ownerId } = z.object({ ownerId: z.uuid("Select a user") }).strict().parse(req.body);
  const [current, found] = await Promise.all([findLead(req, id), loadReferences({ ownerId })]);
  if (current.ownerId === ownerId) return void res.json(toLead(current));
  refuseBadReferences({ ownerId }, found);

  const saved = await updateWithHistory("leads", id, {
    set: { ownerId },
    history: [
      { table: "lead_activities", rows: [{ leadId: id, actorId: me(req).id, type: "assigned", message: `Assigned to ${found.owner!.name}` }] },
      { table: "audit_logs", rows: [{ actorId: me(req).id, action: "lead_assigned", entityType: "lead", entityId: id, before: { ownerId: current.ownerId }, after: { ownerId }, ip: req.ip }] },
    ],
  });
  if (!saved) throw notFound("Lead"); // deleted meanwhile
  res.json(toLead({ ...current, updatedAt: saved.updatedAt, version: saved.version!, ownerId, owner: { id: found.owner!.id, name: found.owner!.name } }));
});

leadsRouter.get("/leads/:id/activities", requirePermission("leads"), async (req, res) => {
  const id = idParam(req);
  const q = pageQuery.parse(req.query);
  const where = { leadId: id };
  // The access check runs alongside the reads (one round trip); nothing is sent unless it passes.
  const [, rows, total] = await Promise.all([
    findLead(req, id),
    prisma.leadActivity.findMany({
      where,
      include: { actor: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...paged(q),
    }),
    prisma.leadActivity.count({ where }),
  ]);
  const items = rows.map((a) => ({ id: a.id, type: a.type, text: a.message, actor: a.actor, createdAt: a.createdAt }));
  res.json(listOf(items, q, total));
});

// Stored only: who gets reminded and how (in-app, email…) awaits report Q18/Q19.
leadsRouter.post("/leads/:id/reminders", requirePermission("leads"), async (req, res) => {
  const id = idParam(req);
  const body = z
    .object({ title: text(200), dueAt: z.iso.datetime({ offset: true, message: "Use an ISO 8601 date-time with a time zone" }), notes: optText(2000) })
    .strict()
    .parse(req.body);
  if (new Date(body.dueAt) <= new Date()) throw invalid({ dueAt: "Must be in the future" });
  await findLead(req, id);

  const reminder = await prisma.$transaction(async (tx) => {
    const r = await tx.reminder.create({
      data: { leadId: id, title: body.title, dueAt: new Date(body.dueAt), notes: body.notes ?? null, createdById: me(req).id },
    });
    await tx.leadActivity.create({ data: { leadId: id, actorId: me(req).id, type: "reminder_scheduled", message: `Reminder scheduled: ${body.title}` } });
    return r;
  });
  res.status(201).json({ id: reminder.id, title: reminder.title, dueAt: reminder.dueAt, notes: reminder.notes, createdAt: reminder.createdAt });
});
