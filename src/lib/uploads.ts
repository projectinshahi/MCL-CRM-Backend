import { Readable } from "node:stream";
import type { Request, RequestHandler, Response } from "express";
import multer from "multer";
import { AppError, invalid } from "./errors.ts";
import { extForMime, MAX_FILE_BYTES, MAX_FILES, type FileKind } from "./files.ts";
import { logger } from "./logger.ts";
import * as storage from "./storage.ts";

// Shared by lead and customer files: multipart parsing with the same limits, uploading to Cloudinary with clean-up
// when anything fails, and streaming a private file back under its own name.

const parseFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 4, fieldSize: 256 * 1024 },
  defParamCharset: "utf8", // browsers send file names as UTF-8; the default (latin1) garbles "Rate card – Dubai.pdf"
}).array("files", MAX_FILES);
const MB = MAX_FILE_BYTES / 1024 / 1024;

/** multipart/form-data → req.files (up to MAX_FILES, MAX_FILE_BYTES each); other content types pass through. */
export const multipartFiles: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) return next();
  parseFiles(req, res, (err: unknown) => {
    if (!err) return next();
    if (!(err instanceof multer.MulterError)) return next(new AppError(400, "MALFORMED_UPLOAD", "The upload was interrupted or could not be read. Please try again."));
    if (err.code === "LIMIT_FILE_SIZE") return next(new AppError(413, "FILE_TOO_LARGE", `Each file must be ${MB} MB or smaller.`, { attachments: `Each file must be ${MB} MB or smaller.` }));
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") return next(invalid({ attachments: `Attach at most ${MAX_FILES} files.` }));
    next(new AppError(400, "MALFORMED_UPLOAD", "The upload could not be read. Please try again."));
  });
};

/** A JSON array sent alongside the files ("originalSizes", "ids"); anything unreadable counts as absent. */
export function formArray(req: Request, field: string): unknown[] {
  try {
    const v = JSON.parse(String(req.body?.[field] ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Sizes before in-browser compression, kept only when they make sense (bigger than what arrived). */
export function originalSizes(req: Request, files: Express.Multer.File[]) {
  const sizes = formArray(req, "originalSizes");
  return files.map((f, i) => {
    const n = sizes[i];
    return Number.isInteger(n) && (n as number) > f.size && (n as number) <= 100 * 1024 * 1024 ? (n as number) : null;
  });
}

export type Upload = { attachmentId: string; stored: storage.StoredFile; file: Express.Multer.File; mime: string; original: number | null };

/** Best effort: a file that cannot be deleted is logged by its storage id for manual clean-up. */
export async function discard(uploads: Pick<Upload, "stored">[]) {
  const results = await Promise.allSettled(uploads.map((u) => storage.remove(u.stored)));
  results.forEach((r, i) => r.status === "rejected" && logger.warn({ publicId: uploads[i]!.stored.publicId, reason: String(r.reason?.message ?? r.reason) }, "could not delete an unused attachment from Cloudinary"));
}

/** Uploads every file, or none: if any fails, the ones that made it are deleted again and nothing is saved. */
export async function uploadAll(uploads: Upload[]) {
  const results = await Promise.allSettled(uploads.map((u) => storage.upload(u.stored, u.file.buffer)));
  const failed = uploads.filter((_, i) => results[i]!.status === "rejected");
  if (!failed.length) return;
  results.forEach((r) => r.status === "rejected" && logger.warn({ reason: String(r.reason?.message ?? r.reason) }, "attachment upload to Cloudinary failed"));
  await discard(uploads.filter((_, i) => results[i]!.status === "fulfilled"));
  const names = failed.map((u) => `“${u.file.originalname}”`).join(", ");
  throw new AppError(502, "UPLOAD_FAILED", `Couldn't upload ${names}. Nothing was saved, please try again.`, { attachments: `Couldn't upload ${names}. Please try again.` });
}

/**
 * Streams a private file to a caller the route has already authorised, under its original name. The signed
 * Cloudinary link (valid for a minute) never leaves the server.
 */
export async function streamAttachment(res: Response, a: { publicId: string; resourceType: string; mimeType: string; fileName: string }) {
  const upstream = await fetch(storage.downloadUrl({ publicId: a.publicId, resourceType: a.resourceType as FileKind["resourceType"], ext: extForMime(a.mimeType) })).catch(() => null);
  if (!upstream?.ok || !upstream.body) throw new AppError(502, "DOWNLOAD_FAILED", "The file couldn't be fetched right now. Please try again.");
  const ascii = a.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  res.set({
    "Content-Type": a.mimeType,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
    "Cache-Control": "private, no-store",
  });
  const length = upstream.headers.get("content-length");
  if (length) res.set("Content-Length", length);
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
}
