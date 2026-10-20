import { beforeEach, describe, expect, it, vi } from "vitest";
import { API, hasDb, makeUser, login, prisma, resetDb, signedIn } from "../helpers.ts";

// Cloudinary is replaced by an in-memory store so failures can be simulated; everything else (routes, validation,
// transactions, database) is real. The real upload/download/delete path is exercised separately against Cloudinary.
const cloud = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  removed: [] as string[],
  uploads: 0,
  fail: ((_publicId: string) => false) as (publicId: string) => boolean,
  during: async () => {},
  dropDownload: false, // Cloudinary's connection fails partway through sending the file
}));
vi.mock("../../src/lib/storage.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/storage.ts")>();
  return {
    ...real,
    upload: vi.fn(async (f: { publicId: string }, bytes: Buffer) => {
      cloud.uploads++;
      await cloud.during();
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
  if (bytes && cloud.dropDownload) {
    let sent = false;
    const body = new ReadableStream({
      pull(c) {
        if (sent) return c.error(new Error("connection reset"));
        c.enqueue(new Uint8Array(bytes.subarray(0, 8)));
        sent = true;
      },
    });
    return new Response(body, { headers: { "content-length": String(bytes.length) } });
  }
  return bytes ? new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } }) : new Response("missing", { status: 404 });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
const leadCount = () => prisma.lead.count();

describe.skipIf(!hasDb)("lead attachments", () => {
  beforeEach(async () => {
    await resetDb();
    cloud.files.clear();
    cloud.removed.length = 0;
    cloud.uploads = 0;
    cloud.fail = () => false;
    cloud.during = async () => {};
    cloud.dropDownload = false;
  });

  it("creates a lead with a PDF and an image in one request; metadata is linked to the lead", async () => {
    const { agent, user } = await signedIn(["leads"]);
    const res = await agent
      .post(`${API}/leads`)
      .field("lead", JSON.stringify({ title: "Air freight", contact: { name: "Test Contact" }, shipment: { shipmentType: "air" } }))
      .field("originalSizes", JSON.stringify([null, 999_999]))
      .attach("files", PDF, "Packing list (Dubai).pdf")
      .attach("files", PNG, "label.png");
    expect(res.status).toBe(201);
    expect(res.body.shipment.shipmentType).toBe("air");
    expect(res.body.attachments).toMatchObject([
      { fileName: "Packing list (Dubai).pdf", mimeType: "application/pdf", sizeBytes: PDF.length, originalSizeBytes: null },
      { fileName: "label.png", mimeType: "image/png", sizeBytes: PNG.length, originalSizeBytes: 999_999 },
    ]);
    const rows = await prisma.leadAttachment.findMany({ where: { leadId: res.body.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.uploadedById === user.id && r.publicId.startsWith(`mcl-crm-test/leads/${res.body.id}/`))).toBe(true);
    expect([...cloud.files.keys()].sort()).toEqual(rows.map((r) => r.publicId).sort());
    expect((await agent.get(`${API}/leads/${res.body.id}`)).body.attachments).toHaveLength(2);
    expect((await agent.get(`${API}/leads`)).body.items[0]).not.toHaveProperty("attachments"); // lists stay light
    const activity = await agent.get(`${API}/leads/${res.body.id}/activities`);
    expect(activity.body.items.find((a: { type: string }) => a.type === "created").text).toMatch(/with 2 files$/);
  });

  it("refuses unsupported, disguised, oversized and too many files before uploading or saving anything", async () => {
    const { agent } = await signedIn(["leads"]);
    const lead = JSON.stringify({ title: "x", contact: { name: "Test Contact" } });
    const fake = await agent.post(`${API}/leads`).field("lead", lead).attach("files", EXE, "invoice.pdf");
    expect(fake.status).toBe(422);
    expect(fake.body.error.fields.attachments).toMatch(/“invoice\.pdf” doesn't look like a real \.pdf file/);
    const exe = await agent.post(`${API}/leads`).field("lead", lead).attach("files", EXE, "setup.exe");
    expect(exe.body.error.fields.attachments).toMatch(/isn't a supported file type/);
    const big = await agent.post(`${API}/leads`).field("lead", lead).attach("files", Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), "big.pdf");
    expect(big.status).toBe(413);
    expect(big.body.error.fields.attachments).toBe("Each file must be 10 MB or smaller.");
    let many = agent.post(`${API}/leads`).field("lead", lead);
    for (let i = 0; i < 6; i++) many = many.attach("files", PDF, `f${i}.pdf`);
    expect((await many).body.error.fields.attachments).toBe("Attach at most 5 files.");
    expect(cloud.uploads).toBe(0);
    expect(await leadCount()).toBe(0);
  });

  it("a Cloudinary failure saves nothing, removes the files that did upload, and names the failed file", async () => {
    const { agent } = await signedIn(["leads"]);
    let n = 0;
    cloud.fail = () => ++n === 2;
    const res = await agent
      .post(`${API}/leads`)
      .field("lead", JSON.stringify({ title: "Will fail", contact: { name: "Test Contact" } }))
      .attach("files", PDF, "a.pdf")
      .attach("files", PNG, "b.png");
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("UPLOAD_FAILED");
    expect(res.body.error.message).toMatch(/Couldn't upload “(a\.pdf|b\.png)”\. Nothing was saved/);
    expect(cloud.files.size).toBe(0); // the one that succeeded was deleted again
    expect(cloud.removed).toHaveLength(1);
    expect(await leadCount()).toBe(0);
    // Retrying the same submission works once Cloudinary is back.
    cloud.fail = () => false;
    const retry = await agent.post(`${API}/leads`).field("lead", JSON.stringify({ title: "Will fail", contact: { name: "Test Contact" } })).attach("files", PDF, "a.pdf").attach("files", PNG, "b.png");
    expect(retry.status).toBe(201);
    expect(retry.body.attachments).toHaveLength(2);
  });

  it("if saving fails after the upload (an id taken meanwhile), the uploaded files are deleted again", async () => {
    const { agent } = await signedIn(["leads"]);
    const other = await makeUser(["leads"]);
    const id = crypto.randomUUID();
    const status = await prisma.leadStatus.findFirstOrThrow();
    cloud.during = async () => {
      cloud.during = async () => {};
      await prisma.lead.create({ data: { id, title: "Someone else's", statusId: status.id, createdById: other.user.id, ownerId: other.user.id } });
    };
    const res = await agent.post(`${API}/leads`).field("lead", JSON.stringify({ id, title: "Mine", contact: { name: "Test Contact" } })).attach("files", PDF, "a.pdf");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("LEAD_ID_TAKEN");
    expect(cloud.files.size).toBe(0);
    expect(cloud.removed).toHaveLength(1);
    expect(await prisma.leadAttachment.count()).toBe(0);
  });

  it("submitting twice with the same form id creates one lead and uploads once", async () => {
    const { agent } = await signedIn(["leads"]);
    const id = crypto.randomUUID();
    const send = () => agent.post(`${API}/leads`).field("lead", JSON.stringify({ id, title: "Once", contact: { name: "Test Contact" } })).attach("files", PDF, "a.pdf");
    const first = await send();
    const second = await send(); // e.g. a retry after the first response was lost
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.id).toBe(id);
    expect(second.body.attachments).toHaveLength(1);
    expect(cloud.uploads).toBe(1);
    expect(await leadCount()).toBe(1);
    // Without files (plain JSON) the database's unique id does the same.
    const id2 = crypto.randomUUID();
    const a = await agent.post(`${API}/leads`).send({ id: id2, title: "Twice", contact: { name: "Test Contact" } });
    const b = await agent.post(`${API}/leads`).send({ id: id2, title: "Twice", contact: { name: "Test Contact" } });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(await leadCount()).toBe(2);
  });

  it("downloads stream the original with its name, only to users who can see the lead", async () => {
    const owner = await signedIn(["leads"]);
    const created = await owner.agent.post(`${API}/leads`).field("lead", JSON.stringify({ title: "Docs", contact: { name: "Test Contact" } })).attach("files", PDF, "Rate card – Dubai.pdf");
    const att = created.body.attachments[0];
    const url = `${API}/leads/${created.body.id}/attachments/${att.id}`;
    const res = await owner.agent.get(url).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="Rate card _ Dubai.pdf"; filename*=UTF-8''${encodeURIComponent("Rate card – Dubai.pdf")}`);
    expect(att.fileName).toBe("Rate card – Dubai.pdf"); // stored as typed, not garbled
    expect(res.headers["cache-control"]).toBe("private, no-store");
    // Another user without "All records" cannot see the lead, so the file does not exist for them.
    const outsider = await login((await makeUser(["leads"])).email);
    expect((await outsider.get(url)).status).toBe(404);
    expect((await owner.agent.get(`${API}/leads/${created.body.id}/attachments/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await owner.agent.get(`${API}/leads/${created.body.id}/attachments/not-a-uuid`)).status).toBe(404);
  });

  it("a download cut off by Cloudinary ends that download only: the API keeps running", async () => {
    const owner = await signedIn(["leads"]);
    const created = await owner.agent.post(`${API}/leads`).field("lead", JSON.stringify({ title: "Docs", contact: { name: "Test Contact" } })).attach("files", PDF, "big.pdf");
    const url = `${API}/leads/${created.body.id}/attachments/${created.body.attachments[0].id}`;
    cloud.dropDownload = true;
    // pipe() left the source's error unhandled: an uncaught exception that stopped the whole process (vitest
    // reports it as an unhandled error). The client sees a broken-off transfer instead.
    const cut = await owner.agent.get(url).then((r) => r.status, (e: Error) => e.message);
    expect(cut).not.toBe(200);
    cloud.dropDownload = false;
    expect((await owner.agent.get(url)).status).toBe(200);
    expect((await owner.agent.get(`${API}/auth/me`)).status).toBe(200);
  });

  it("needs the leads permission and a signed-in user", async () => {
    const { agent } = await signedIn(["dashboard"]);
    const res = await agent.post(`${API}/leads`).field("lead", JSON.stringify({ title: "x", contact: { name: "Test Contact" } })).attach("files", PDF, "a.pdf");
    expect(res.status).toBe(403);
    expect(cloud.uploads).toBe(0);
  });
});
