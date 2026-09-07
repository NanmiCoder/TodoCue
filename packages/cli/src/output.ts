import { TodoCueError, type Reminder, type Series, type Task } from "@todocue/shared";
import { formatLocal } from "@todocue/engine";

export interface OutputOptions {
  json: boolean;
}

export function print(opts: OutputOptions, data: unknown, human: () => string): void {
  if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else process.stdout.write(human() + "\n");
}

export function printError(opts: OutputOptions, err: unknown): void {
  if (err instanceof TodoCueError) {
    if (opts.json) process.stderr.write(JSON.stringify(err.toBody()) + "\n");
    else {
      process.stderr.write(`error [${err.code}]: ${err.message}\n`);
      const hint = (err.details as { hint?: string } | undefined)?.hint;
      if (hint) process.stderr.write(`hint: ${hint}\n`);
    }
    return;
  }
  const e = err as Error;
  if (opts.json) process.stderr.write(JSON.stringify({ error: { code: "INTERNAL", message: e.message } }) + "\n");
  else process.stderr.write(`error: ${e.message}\n`);
}

const PRIORITY_MARK: Record<Task["priority"], string> = { none: " ", low: "·", medium: "!", high: "‼" };
const STATUS_MARK: Record<Task["status"], string> = { todo: "[ ]", done: "[x]", cancelled: "[-]", skipped: "[>]" };

export function whenOf(t: Task): string {
  const parts: string[] = [];
  if (t.scheduledAt) parts.push(`计划 ${formatLocal(t.scheduledAt, t.timezone, "MM-dd HH:mm")}`);
  else if (t.scheduledDate) parts.push(`计划 ${t.scheduledDate.slice(5)}`);
  if (t.dueAt) parts.push(`截止 ${formatLocal(t.dueAt, t.timezone, "MM-dd HH:mm")}`);
  else if (t.dueDate) parts.push(`截止 ${t.dueDate.slice(5)}`);
  if (t.reminderAt) parts.push(`提醒 ${formatLocal(t.reminderAt, t.timezone, "MM-dd HH:mm")}`);
  return parts.join("  ");
}

export function formatTaskLine(t: Task, extra?: string): string {
  const meta = [t.project ? `#${t.project}` : "", whenOf(t), t.estimateMinutes ? `~${t.estimateMinutes}m` : "", t.seriesId ? "⟳" : ""]
    .filter(Boolean)
    .join("  ");
  const line = `${STATUS_MARK[t.status]} ${PRIORITY_MARK[t.priority]} ${t.id}  ${t.title}${meta ? `\n        ${meta}` : ""}`;
  return extra ? `${line}\n        ${extra}` : line;
}

export function formatTaskDetail(t: Task, series: Series | null, reminder: Reminder | null): string {
  const rows: [string, string][] = [
    ["id", t.id],
    ["title", t.title],
    ["status", t.status + (t.completedAt ? ` (${formatLocal(t.completedAt, t.timezone)})` : "")],
    ["priority", t.priority],
    ["project", t.project ?? "-"],
    ["estimate", t.estimateMinutes ? `${t.estimateMinutes} min` : "-"],
    ["scheduled", t.scheduledAt ? formatLocal(t.scheduledAt, t.timezone) : (t.scheduledDate ?? "-")],
    ["due", t.dueAt ? formatLocal(t.dueAt, t.timezone) : (t.dueDate ?? "-")],
    ["reminder", t.reminderAt ? formatLocal(t.reminderAt, t.timezone) : "-"],
    ["timezone", t.timezone],
    ["notes", t.notes ?? "-"],
    ["version", String(t.version)],
    ["created", formatLocal(t.createdAt, t.timezone)],
    ["updated", formatLocal(t.updatedAt, t.timezone)],
  ];
  if (series) rows.push(["series", `${series.id} ${describeRule(series)} (${series.status}), occurrence ${t.occurrenceDate}`]);
  if (reminder) rows.push(["reminder state", `${reminder.status}${reminder.channel ? ` via ${reminder.channel}` : ""}${reminder.lastError ? ` — ${reminder.lastError}` : ""}`]);
  return rows.map(([k, v]) => `${k.padEnd(15)} ${v}`).join("\n");
}

export function describeRule(s: Series): string {
  const names = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const rule = s.rule.kind === "daily" ? "每天" : `每周 ${s.rule.weekdays.map((d) => names[d]).join("、")}`;
  return [rule, s.scheduledTime ? `计划 ${s.scheduledTime}` : "", s.reminderTime ? `提醒 ${s.reminderTime}` : ""].filter(Boolean).join(" · ");
}

export function formatSeriesLine(s: Series): string {
  return `${s.status === "active" ? "⟳" : "⏹"} ${s.id}  ${s.title}\n        ${describeRule(s)}${s.project ? `  #${s.project}` : ""}  起 ${s.startDate}${s.endDate ? ` 止 ${s.endDate}` : ""}`;
}

export function formatReminderLine(r: Reminder, tz: string, title?: string): string {
  return `${r.status.padEnd(9)} ${formatLocal(r.fireAt, tz)}  ${r.taskId}${title ? `  ${title}` : ""}${r.channel ? `  via ${r.channel}` : ""}${r.lastError ? `  ✗ ${r.lastError}` : ""}`;
}
