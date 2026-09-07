import { createHash, randomUUID } from "node:crypto";
import { AttachmentUpload, attachmentMediaType, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TASK_ATTACHMENT_BYTES, TodoCueError, type Attachment } from "@todocue/shared";
import type { SqliteDatabase } from "./db.js";

interface AttachmentRow {
  id: string; task_id: string; name: string; media_type: string; size: number; sha256: string; created_at: string;
}
const columns = "id, task_id, name, media_type, size, sha256, created_at";
const metadata = (r: AttachmentRow): Attachment => ({
  id: r.id, taskId: r.task_id, name: r.name, mediaType: r.media_type, size: r.size, sha256: r.sha256, createdAt: r.created_at,
});

/** Bytes and metadata share the task's SQLite transaction and backup; no dangling external paths. */
export class AttachmentStore {
  constructor(private db: SqliteDatabase) {}

  list(taskId: string): Attachment[] {
    return (this.db.prepare(`SELECT ${columns} FROM attachments WHERE task_id = ? ORDER BY rowid`).all(taskId) as AttachmentRow[]).map(metadata);
  }

  get(taskId: string, id: string): { attachment: Attachment; data: Buffer } {
    const row = this.db.prepare(`SELECT ${columns}, content FROM attachments WHERE task_id = ? AND id = ?`).get(taskId, id) as
      (AttachmentRow & { content: Buffer }) | undefined;
    if (!row) throw TodoCueError.notFound("attachment", id);
    return { attachment: metadata(row), data: row.content };
  }

  add(taskId: string, files: AttachmentUpload[], now: string): void {
    const existing = this.list(taskId);
    if (existing.length + files.length > MAX_ATTACHMENTS) throw TodoCueError.validation("a task supports at most 20 attachments");
    const decoded = files.map((raw) => {
      const file = AttachmentUpload.parse(raw);
      const data = Buffer.from(file.dataBase64, "base64");
      if (data.length > MAX_ATTACHMENT_BYTES) throw TodoCueError.validation("attachment exceeds 10 MiB", { name: file.name });
      if (data.toString("base64") !== file.dataBase64) throw TodoCueError.validation("invalid base64 attachment", { name: file.name });
      return { file, data };
    });
    if (existing.reduce((n, a) => n + a.size, 0) + decoded.reduce((n, a) => n + a.data.length, 0) > MAX_TASK_ATTACHMENT_BYTES) {
      throw TodoCueError.validation("task attachments exceed 30 MiB in total");
    }
    const insert = this.db.prepare(`INSERT INTO attachments (id, task_id, name, media_type, size, sha256, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const { file, data } of decoded) {
      insert.run(`a_${randomUUID()}`, taskId, file.name, attachmentMediaType(file.name, file.mediaType),
        data.length, createHash("sha256").update(data).digest("hex"), data, now);
    }
  }

  remove(taskId: string, ids: string[]): void {
    for (const id of new Set(ids)) {
      const result = this.db.prepare("DELETE FROM attachments WHERE task_id = ? AND id = ?").run(taskId, id);
      if (!result.changes) throw TodoCueError.notFound("attachment", id);
    }
  }

  export(): (Attachment & { dataBase64: string })[] {
    const rows = this.db.prepare(`SELECT ${columns}, content FROM attachments ORDER BY rowid`).all() as (AttachmentRow & { content: Buffer })[];
    return rows.map((r) => ({ ...metadata(r), dataBase64: r.content.toString("base64") }));
  }
}
