import fs from "node:fs/promises";
import path from "node:path";
import { attachmentMediaType, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TASK_ATTACHMENT_BYTES, TodoCueError, type AttachmentUpload } from "@todocue/shared";

/** CLI/MCP read explicit local files; the HTTP server never accepts arbitrary filesystem paths. */
export async function readAttachments(paths: string[]): Promise<AttachmentUpload[]> {
  if (paths.length > MAX_ATTACHMENTS) throw TodoCueError.validation("at most 20 attachments per task");
  const files: AttachmentUpload[] = [];
  let total = 0;
  for (const filePath of paths) {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw TodoCueError.validation("attachment must be a regular file", { path: filePath });
      if (stat.size > MAX_ATTACHMENT_BYTES) throw TodoCueError.validation("attachment exceeds 10 MiB", { path: filePath });
      // Bounded read also protects against a file growing after stat().
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_ATTACHMENT_BYTES + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw TodoCueError.validation("attachment changed while reading; retry", { path: filePath });
      total += bytesRead;
      if (total > MAX_TASK_ATTACHMENT_BYTES) throw TodoCueError.validation("attachments exceed 30 MiB in total");
      files.push({ name: path.basename(filePath), mediaType: attachmentMediaType(path.basename(filePath)),
        dataBase64: buffer.subarray(0, bytesRead).toString("base64") });
    } finally { await handle.close(); }
  }
  return files;
}
