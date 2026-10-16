// What a lead attachment may be. The type is decided from the file's first bytes; the name's extension must agree,
// so a renamed executable or script is refused however it is labelled. MCL-CRM-Frontend/lib/attachments.ts mirrors
// these limits for early feedback; this check is the one that counts.

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // per file, as uploaded (after any in-browser compression)
export const MAX_FILES = 5; // per request

export type FileKind = { mime: string; ext: string; resourceType: "image" | "raw" };

const kind = (mime: string, ext: string, resourceType: FileKind["resourceType"] = "raw"): FileKind => ({ mime, ext, resourceType });
const KINDS = {
  jpg: kind("image/jpeg", "jpg", "image"),
  png: kind("image/png", "png", "image"),
  webp: kind("image/webp", "webp", "image"),
  heic: kind("image/heic", "heic", "image"),
  pdf: kind("application/pdf", "pdf"),
  doc: kind("application/msword", "doc"),
  xls: kind("application/vnd.ms-excel", "xls"),
  docx: kind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
  xlsx: kind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
};
const ALIASES: Record<string, keyof typeof KINDS> = { jpeg: "jpg", heif: "heic" };
export const ALLOWED_EXTENSIONS = [...Object.keys(KINDS), ...Object.keys(ALIASES)];
export const extForMime = (mime: string) => Object.values(KINDS).find((k) => k.mime === mime)?.ext ?? "";

const starts = (buf: Buffer, bytes: number[], at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (buf: Buffer, from: number, to: number) => buf.subarray(from, to).toString("latin1");

/** What the bytes are, if they are one of the allowed kinds. Office formats are told apart by their name. */
function sniff(buf: Buffer, ext: string): FileKind | null {
  if (starts(buf, [0xff, 0xd8, 0xff])) return KINDS.jpg;
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return KINDS.png;
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return KINDS.webp;
  if (ascii(buf, 4, 8) === "ftyp" && ["heic", "heix", "hevc", "mif1", "msf1"].includes(ascii(buf, 8, 12))) return KINDS.heic;
  if (ascii(buf, 0, 1024).includes("%PDF-")) return KINDS.pdf; // the header may follow a little leading junk
  // Legacy Word/Excel share one container (OLE2); OOXML (docx/xlsx) is a ZIP whose part names say which it is.
  if (starts(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return ext === "xls" ? KINDS.xls : ext === "doc" ? KINDS.doc : null;
  if (starts(buf, [0x50, 0x4b, 0x03, 0x04])) {
    if (ext === "docx" && buf.includes("word/")) return KINDS.docx;
    if (ext === "xlsx" && buf.includes("xl/")) return KINDS.xlsx;
  }
  return null;
}

const extOf = (name: string) => {
  const e = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return ALIASES[e] ?? e;
};

/** The file's kind, or why it is refused. Size is checked by the upload parser before the bytes are read. */
export function checkFile(name: string, buf: Buffer): FileKind | { error: string } {
  if (name.length > 200) return { error: `“${name.slice(0, 40)}…” has a name longer than 200 characters. Rename it and try again.` };
  const ext = extOf(name);
  if (!(ext in KINDS)) return { error: `“${name}” isn't a supported file type. Use PDF, Word, Excel, JPG, PNG, WEBP or HEIC.` };
  if (!buf.length) return { error: `“${name}” is empty.` };
  const k = sniff(buf, ext);
  if (!k || k.ext !== ext) return { error: `“${name}” doesn't look like a real .${ext} file, so it was not accepted.` };
  return k;
}
