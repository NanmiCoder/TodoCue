import {
  API_PREFIX,
  ErrorCodes,
  TodoCueError,
  type ConnectionInfo,
  type ContextInfo,
  type CreateSeriesInput,
  type CreateTaskInput,
  type DoctorReport,
  type ExportBundle,
  type ListRemindersQuery,
  type ListTasksQuery,
  type NextResult,
  type Reminder,
  type RuntimeEvent,
  type Series,
  type SnoozeInput,
  type Task,
  type TodayResult,
  type UpdateTaskInput,
  type VersionedAction,
} from "@todocue/shared";
import { readJsonFile, resolveHome, runtimePaths } from "./config.js";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  idempotencyKey?: string;
}

/** Thin typed HTTP client for the Local API; used by the CLI and MCP server. */
export class TodoCueClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Build a client from ~/.todocue/connection.json; null when the runtime never started. */
  static fromHome(home?: string): TodoCueClient | null {
    const paths = runtimePaths(resolveHome(home));
    const info = readJsonFile<ConnectionInfo>(paths.connection);
    if (!info?.baseUrl || !info.token) return null;
    return new TodoCueClient({ baseUrl: info.baseUrl, token: info.token });
  }

  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new TodoCueError(ErrorCodes.UNAVAILABLE, `cannot reach TodoCue runtime at ${this.baseUrl}: ${(e as Error).message}`, {
        hint: "run `todocue service start` (or `todocue serve` in a terminal)",
      });
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      const code = (err?.code && err.code in ErrorCodes ? err.code : ErrorCodes.INTERNAL) as keyof typeof ErrorCodes;
      throw new TodoCueError(ErrorCodes[code], err?.message ?? `HTTP ${res.status}`, err?.details);
    }
    return json as T;
  }

  health() {
    return this.request<{ ok: boolean; runtimeVersion: string; pid: number }>("GET", "/health");
  }
  context() {
    return this.request<ContextInfo>("GET", "/context");
  }
  listTasks(q: ListTasksQuery = {}) {
    return this.request<{ tasks: Task[] }>("GET", `/tasks${toQuery(q)}`);
  }
  createTask(input: CreateTaskInput, opts?: RequestOptions) {
    return this.request<{ task: Task; series: Series | null }>("POST", "/tasks", input, opts);
  }
  getTask(id: string) {
    return this.request<{ task: Task; series: Series | null; reminder: Reminder | null }>("GET", `/tasks/${encodeURIComponent(id)}`);
  }
  updateTask(id: string, patch: UpdateTaskInput, opts?: RequestOptions) {
    return this.request<{ task: Task }>("PATCH", `/tasks/${encodeURIComponent(id)}`, patch, opts);
  }
  completeTask(id: string, body: VersionedAction = {}, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/complete`, body, opts);
  }
  reopenTask(id: string, body: VersionedAction = {}, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/reopen`, body, opts);
  }
  cancelTask(id: string, body: VersionedAction = {}, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/cancel`, body, opts);
  }
  skipTask(id: string, body: VersionedAction = {}, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/skip`, body, opts);
  }
  snoozeTask(id: string, body: SnoozeInput = {}, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/snooze`, body, opts);
  }
  today() {
    return this.request<TodayResult>("GET", "/today");
  }
  next() {
    return this.request<NextResult>("GET", "/next");
  }
  projects() {
    return this.request<{ projects: string[] }>("GET", "/projects");
  }
  createSeries(input: CreateSeriesInput, opts?: RequestOptions) {
    return this.request<{ series: Series; tasks: Task[] }>("POST", "/series", input, opts);
  }
  listSeries(status?: "active" | "stopped") {
    return this.request<{ series: Series[] }>("GET", `/series${status ? `?status=${status}` : ""}`);
  }
  getSeries(id: string) {
    return this.request<{ series: Series; tasks: Task[] }>("GET", `/series/${encodeURIComponent(id)}`);
  }
  stopSeries(id: string, body: VersionedAction = {}, opts?: RequestOptions) {
    return this.request<{ series: Series; cancelledTaskIds: string[] }>("POST", `/series/${encodeURIComponent(id)}/stop`, body, opts);
  }
  listReminders(q: ListRemindersQuery = {}) {
    return this.request<{ reminders: Reminder[] }>("GET", `/reminders${toQuery(q)}`);
  }
  export() {
    return this.request<ExportBundle>("GET", "/export");
  }
  doctor() {
    return this.request<DoctorReport>("GET", "/doctor");
  }
  requestNotificationAuthorization() {
    return this.request<{ authorization: string; available: boolean; detail: string | null }>("POST", "/notifications/request-authorization", {});
  }
  testNotification(body: { title?: string; body?: string } = {}) {
    return this.request<{ ok: boolean; channel: string }>("POST", "/notifications/test", body);
  }

  /**
   * Subscribe to server-sent events. Resolves when the stream ends or the
   * signal aborts; callers reconnect themselves (and re-sync state).
   */
  async events(onEvent: (ev: RuntimeEvent) => void, opts: { signal?: AbortSignal; lastEventId?: number } = {}): Promise<void> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" };
    if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = String(opts.lastEventId);
    const res = await fetch(`${this.baseUrl}${API_PREFIX}/events`, { headers, signal: opts.signal });
    if (!res.ok || !res.body) throw new TodoCueError(ErrorCodes.UNAVAILABLE, `events stream failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as RuntimeEvent);
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  }
}

function toQuery(q: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) p.set(k, v.join(","));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
