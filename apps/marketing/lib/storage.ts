import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

/**
 * Upload an image to storage.
 * Uses Vercel Blob in production, local public/ directory in dev.
 */
export async function uploadImage(
  buffer: Buffer,
  filename: string,
): Promise<string> {
  if (USE_BLOB) {
    const { put } = await import("@vercel/blob");
    const blob = await put(filename, buffer, {
      access: "public",
      contentType: filename.endsWith(".jpg") || filename.endsWith(".jpeg")
        ? "image/jpeg"
        : "image/png",
    });
    return blob.url;
  }

  // Local dev: write to public/uploads/ and serve via Next.js static
  const relativePath = join("uploads", filename);
  const fullPath = join(process.cwd(), "public", relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, buffer);
  return `/${relativePath}`;
}

/**
 * Delete an image from storage.
 */
export async function deleteImage(url: string): Promise<void> {
  if (USE_BLOB) {
    const { del } = await import("@vercel/blob");
    await del(url);
  }
  // Local dev: could unlink, but not worth the complexity
}
