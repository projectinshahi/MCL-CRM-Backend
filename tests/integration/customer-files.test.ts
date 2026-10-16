import { beforeEach, describe, expect, it, vi } from "vitest";
import { API, hasDb, prisma, resetDb, signedIn } from "../helpers.ts";

// Cloudinary is replaced by an in-memory store (as in attachments.test.ts) so failures can be simulated; routes,
// validation, transactions and the database are real.
const cloud = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  removed: [] as string[],
  uploads: 0,
  fail: ((_publicId: string) => false) as (publicId: string) => boolean,
}));
vi.mock("../../src/lib/storage.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/storage.ts")>();
  return {
    ...real,
    upload: vi.fn(async (f: { publicId: string }, bytes: Buffer) => {
      cloud.uploads++;
      if (cloud.fail(f.publicId)) throw new Error("Cloudinary unavailable");
      cloud.files.set(f.publicId, bytes);
    }),
    remove: vi.fn(async (f: { publicId: string }) => {
      cloud.files.delete(f.publicId);
      cloud.removed.push(f.publicId);
    }),
    downloadUrl: vi.fn((f: { publicId: string }) => `https://cloud.test/${encodeURIComponent(f.publicId)}`),
  };
});
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
  if (!String(url).startsWith("https://cloud.test/")) return realFetch(url, init);
  const bytes = cloud.files.get(decodeURIComponent(String(url).slice("https://cloud.test/".length)));
  return bytes ? new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } }) : new Response("missing", { status: 404 });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);

describe.skipIf(!hasDb)("customer files", () => {
  beforeEach(async () => {
    await resetDb();
    cloud.files.clear();
    cloud.removed.length = 0;
    cloud.uploads = 0;
    cloud.fail = () => false;
  });

  async function customerWithLeadFile() {
    const me = await signedIn(["leads", "customers"]);
    const lead = (
      await me.agent.post(`${API}/leads`).field("lead", JSON.stringify({ title: "With a file", contact: { name: "Arshad" } })).attach("files", PDF, "Lead rate card.pdf")
    ).body;
    const customer = (await me.agent.post(`${API}/leads/${lead.id}/convert`).send({})).body.customer;
    return { ...me, lead, customer };
  }

  it("uploads files to the customer, lists them with metadata, downloads under the original name, removes them", async () => {
    const { agent, user, customer } = await customerWithLeadFile();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const res = await agent
      .post(`${API}/customers/${customer.id}/attachments`)
      .field("ids", JSON.stringify(ids))
      .field("originalSizes", JSON.stringify([null, 999_999]))
      .attach("files", PDF, "Contract – signed.pdf")
      .attach("files", PNG, "visiting card.png");
    expect(res.status).toBe(201);
    expect(res.body.items.map((a: { id: string; fileName: string }) => [a.id, a.fileName])).toEqual([
      [ids[0], "Contract – signed.pdf"],
      [ids[1], "visiting card.png"],
    ]);
    expect(res.body.items[1]).toMatchObject({ mimeType: "image/png", originalSizeBytes: 999_999, uploadedBy: { id: user.id } });
    const rows = await prisma.customerAttachment.findMany({ where: { customerId: customer.id } });
    expect(rows.every((r) => r.publicId.startsWith(`mcl-crm-test/customers/${customer.id}/`))).toBe(true);

    const detail = (await agent.get(`${API}/customers/${customer.id}`)).body;
    expect(detail.attachments).toHaveLength(2);
    expect(detail.leads[0].attachments.map((a: { fileName: string }) => a.fileName)).toEqual(["Lead rate card.pdf"]); // the lead's own file, by reference

    const dl = await agent.get(`${API}/customers/${customer.id}/attachments/${ids[0]}`).buffer(true);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toContain("filename*=UTF-8''Contract%20%E2%80%93%20signed.pdf");
    expect(Buffer.from(dl.body).equals(PDF)).toBe(true);

    expect((await agent.delete(`${API}/customers/${customer.id}/attachments/${ids[0]}`)).status).toBe(204);
    expect(cloud.removed).toEqual([rows.find((r) => r.id === ids[0])!.publicId]);
    expect((await agent.get(`${API}/customers/${customer.id}`)).body.attachments.map((a: { id: string }) => a.id)).toEqual([ids[1]]);
    expect(await prisma.auditLog.count({ where: { action: { in: ["customer_files_added", "customer_file_removed"] } } })).toBe(2);
  });

  it("rejects wrong types, disguised and oversized files before uploading anything", async () => {
    const { agent, customer } = await customerWithLeadFile();
    const before = cloud.uploads;
    const exe = await agent.post(`${API}/customers/${customer.id}/attachments`).attach("files", EXE, "setup.exe");
    expect(exe.status).toBe(422);
    const disguised = await agent.post(`${API}/customers/${customer.id}/attachments`).attach("files", EXE, "invoice.pdf");
    expect(disguised.status).toBe(422);
    const big = await agent.post(`${API}/customers/${customer.id}/attachments`).attach("files", Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), "huge.pdf");
    expect(big.status).toBe(413);
    const none = await agent.post(`${API}/customers/${customer.id}/attachments`).field("ids", "[]");
    expect(none.status).toBe(422);
    expect(cloud.uploads).toBe(before);
    expect(await prisma.customerAttachment.count()).toBe(0);
  });

  it("a failed upload saves nothing and cleans up; retrying the same files never duplicates them", async () => {
    const { agent, customer } = await customerWithLeadFile();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const send = () =>
      agent.post(`${API}/customers/${customer.id}/attachments`).field("ids", JSON.stringify(ids)).attach("files", PDF, "a.pdf").attach("files", PNG, "b.png");

    cloud.fail = (publicId) => publicId.includes(ids[1]!);
    const failed = await send();
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toContain("b.png");
    expect(await prisma.customerAttachment.count()).toBe(0);
    expect(cloud.files.size).toBe(1); // only the lead's file: the customer file that did upload was deleted again

    cloud.fail = () => false;
    expect((await send()).status).toBe(201);
    const uploadsAfterFirst = cloud.uploads;
    const again = await send(); // e.g. the response was lost and the browser retried
    expect(again.status).toBe(201);
    expect(again.body.items).toHaveLength(2);
    expect(cloud.uploads).toBe(uploadsAfterFirst); // already saved: not uploaded again
    expect(await prisma.customerAttachment.count()).toBe(2);
  });

  it("customer files follow the customer's access rules; lead files keep the lead's", async () => {
    const owner = await customerWithLeadFile();
    const stranger = await signedIn(["leads", "customers"]);
    const customersOnly = await signedIn(["customers", "all_records"]);
    const id = crypto.randomUUID();
    await owner.agent.post(`${API}/customers/${owner.customer.id}/attachments`).field("ids", JSON.stringify([id])).attach("files", PDF, "c.pdf");

    for (const r of [
      await stranger.agent.get(`${API}/customers/${owner.customer.id}/attachments/${id}`),
      await stranger.agent.delete(`${API}/customers/${owner.customer.id}/attachments/${id}`),
      await stranger.agent.post(`${API}/customers/${owner.customer.id}/attachments`).attach("files", PDF, "x.pdf"),
    ])
      expect(r.status).toBe(404);
    // Someone else's attachment id under a customer they can see is not found either.
    const mine = (await stranger.agent.post(`${API}/leads`).send({ title: "S", contact: { name: "Sam" } })).body;
    const theirs = (await stranger.agent.post(`${API}/leads/${mine.id}/convert`).send({})).body.customer;
    expect((await stranger.agent.get(`${API}/customers/${theirs.id}/attachments/${id}`)).status).toBe(404);
    // A Customers-only role sees the customer's own files, but not the lead or its files.
    const seen = (await customersOnly.agent.get(`${API}/customers/${owner.customer.id}`)).body;
    expect(seen.attachments.map((a: { id: string }) => a.id)).toEqual([id]);
    expect(seen.leads).toEqual([]);
    const leadFile = (await prisma.leadAttachment.findFirstOrThrow({ where: { leadId: owner.lead.id } })).id;
    expect((await customersOnly.agent.get(`${API}/leads/${owner.lead.id}/attachments/${leadFile}`)).status).toBe(403);
    expect(await prisma.customerAttachment.count()).toBe(1);
  });
});
