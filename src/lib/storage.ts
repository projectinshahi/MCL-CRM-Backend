import { v2 as cloudinary } from "cloudinary";
import { env, storageConfigured } from "../config/env.ts";
import type { FileKind } from "./files.ts";

// Lead and customer attachments in Cloudinary. Every asset is uploaded as type "private": it has no public URL, and the original
// can only be fetched through a signed link valid for one minute, which the API uses itself to stream the file to a
// caller allowed to see the lead (with the original file name). No Cloudinary URL ever reaches the browser.
// Files are stored exactly as received (no incoming transformation), so documents keep every byte.
if (storageConfigured)
  cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });

export type StoredFile = { publicId: string; resourceType: FileKind["resourceType"]; ext: string };

/**
 * Where an attachment lives: `owner` is "leads/<id>" or "customers/<id>". Built only by the API from the owner's and
 * the attachment's own ids, so a user can neither choose nor overwrite another file's location. Documents ("raw")
 * keep their extension in the id.
 */
export function storedFile(owner: `${"leads" | "customers"}/${string}`, attachmentId: string, kind: FileKind): StoredFile {
  const base = `${env.CLOUDINARY_FOLDER}/${owner}/${attachmentId}`;
  return { publicId: kind.resourceType === "raw" ? `${base}.${kind.ext}` : base, resourceType: kind.resourceType, ext: kind.ext };
}

export function upload(file: StoredFile, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { public_id: file.publicId, resource_type: file.resourceType, type: "private", overwrite: false, timeout: 120_000 },
        (err) => (err ? reject(err) : resolve()),
      )
      .end(bytes);
  });
}

export async function remove(file: Omit<StoredFile, "ext">) {
  await cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType, type: "private", invalidate: true });
}

/** Signed link to the original file, valid for one minute. Server-side use only. */
export function downloadUrl(file: StoredFile) {
  return cloudinary.utils.private_download_url(file.publicId, file.resourceType === "raw" ? "" : file.ext, {
    resource_type: file.resourceType,
    type: "private",
    attachment: true,
    expires_at: Math.floor(Date.now() / 1000) + 60,
  });
}
