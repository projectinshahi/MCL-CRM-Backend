import { describe, expect, it } from "vitest";
import { checkFile } from "../../src/lib/files.ts";

// Real file signatures: a complete 1×1 PNG, a minimal PDF, and the documented magic numbers of the other formats.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(8)]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const zip = (part: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from(`[Content_Types].xml${part}document.xml`)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);

const mime = (name: string, buf: Buffer) => {
  const k = checkFile(name, buf);
  return "error" in k ? k.error : `${k.mime} ${k.resourceType}`;
};

describe("checkFile — type decided by content, name must agree", () => {
  it("accepts each supported kind", () => {
    expect(mime("photo.jpg", JPEG)).toBe("image/jpeg image");
    expect(mime("PHOTO.JPEG", JPEG)).toBe("image/jpeg image");
    expect(mime("scan.png", PNG)).toBe("image/png image");
    expect(mime("pic.webp", WEBP)).toBe("image/webp image");
    expect(mime("iphone.HEIC", HEIC)).toBe("image/heic image");
    expect(mime("Packing list.pdf", PDF)).toBe("application/pdf raw");
    expect(mime("old.doc", OLE)).toBe("application/msword raw");
    expect(mime("old.xls", OLE)).toBe("application/vnd.ms-excel raw");
    expect(mime("quote.docx", zip("word/"))).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document raw");
    expect(mime("rates.xlsx", zip("xl/"))).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet raw");
  });

  it("refuses disguised, mislabelled, unsupported and empty files", () => {
    expect(mime("invoice.pdf", EXE)).toMatch(/doesn't look like a real \.pdf file/);
    expect(mime("photo.png", JPEG)).toMatch(/doesn't look like a real \.png file/); // real image, wrong name
    expect(mime("quote.docx", zip("xl/"))).toMatch(/doesn't look like a real \.docx file/);
    expect(mime("setup.exe", EXE)).toMatch(/isn't a supported file type/);
    expect(mime("notes", PDF)).toMatch(/isn't a supported file type/);
    expect(mime("empty.pdf", Buffer.alloc(0))).toMatch(/is empty/);
    expect(mime(`${"a".repeat(200)}.pdf`, PDF)).toMatch(/longer than 200 characters/);
  });
});
