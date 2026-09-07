/** Extension fallback for clients that supply bytes without a MIME type. */
const mediaTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", tiff: "image/tiff", tif: "image/tiff", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json",
  csv: "text/csv", zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg",
};
export function attachmentMediaType(name: string, supplied?: string): string {
  return supplied?.toLowerCase() ?? mediaTypes[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
}
