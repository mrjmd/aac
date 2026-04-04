import { put, del } from "@vercel/blob";

/**
 * Upload an image to Vercel Blob storage.
 * Returns a publicly accessible URL that Buffer can fetch.
 */
export async function uploadImage(
  buffer: Buffer,
  filename: string,
): Promise<string> {
  const blob = await put(filename, buffer, {
    access: "public",
    contentType: filename.endsWith(".jpg") || filename.endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png",
  });
  return blob.url;
}

/**
 * Delete an image from Vercel Blob storage.
 */
export async function deleteImage(url: string): Promise<void> {
  await del(url);
}
