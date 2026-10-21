import {
  API_PREFIX,
  ErrorCodes,
  TodoCueError,
  type AddAttachmentsInput,
  type Attachment,
  type MoveTaskInput, type OrderingState, type ResetOrderInput, type UndoOrderInput,
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
  type CreatePeriodicReminderInput,
  type UpdatePeriodicReminderInput,
  type PeriodicActionInput,
  type PeriodicReminder,
  type PeriodicOccurrence,
} from "@todocue/shared";

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  idempotencyKey?: string;
}

export interface Request { method: string; path: string; body?: unknown; idempotencyKey?: string; }
export interface TransportResponse { status: number; body: unknown; }
export interface Transport { request(input: Request): Promise<TransportResponse>; }
export type ClientOptions = HttpClientOptions | { transport: Transport };

export class HttpTransport implements Transport {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, ""); this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }
  async request({ method, path, body, idempotencyKey }: Request): Promise<TransportResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetch(`${this.baseUrl}${API_PREFIX}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

/** Browser-safe typed Local API client; desktop transports keep tokens in the host. */
export class TodoCueClient {
  private readonly transport: Transport;
  private readonly httpOptions?: HttpClientOptions;
  constructor(opts: ClientOptions) {
    this.transport = "transport" in opts ? opts.transport : new HttpTransport(opts);
    if (!("transport" in opts)) this.httpOptions = opts;
  }
  get baseUrl(): string { return this.httpOptions?.baseUrl.replace(/\/$/, "") ?? "native"; }
  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    let response: TransportResponse;
    try { response = await this.transport.request({ method, path, body, ...opts }); }
    catch (e) { throw new TodoCueError(ErrorCodes.UNAVAILABLE, e instanceof Error ? e.message : String(e)); }
    if (response.status < 200 || response.status >= 300) {
      const error = (response.body as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      const code = error?.code && error.code in ErrorCodes ? ErrorCodes[error.code as keyof typeof ErrorCodes] : ErrorCodes.INTERNAL;
      throw new TodoCueError(code, error?.message ?? `HTTP ${response.status}`, error?.details);
    }
    return response.body as T;
  }
  board() { return this.request<Board>("GET", "/board"); }
  moveTask(id: string, input: MoveTaskInput, opts?: RequestOptions) {
    return this.request<OrderResult>("POST", `/tasks/${encodeURIComponent(id)}/move`, input, opts);
  }
  resetOrder(input: ResetOrderInput, opts?: RequestOptions) { return this.request<OrderResult>("POST", "/ordering/reset", input, opts); }
  undoOrder(input: UndoOrderInput, opts?: RequestOptions) { return this.request<OrderResult>("POST", "/ordering/undo", input, opts); }
  claimPeriodic(id: string, input: PeriodicClaim, opts?: RequestOptions) {
    return this.request<{ reminder: PeriodicReminder }>("POST", `/periodic-reminders/${encodeURIComponent(id)}/claim`, input, opts);
  }
  receiptPeriodic(id: string, input: PeriodicClaim & { displayed: boolean }, opts?: RequestOptions) {
    return this.request<{ reminder: PeriodicReminder }>("POST", `/periodic-reminders/${encodeURIComponent(id)}/receipt`, input, opts);
  }
  health() {
    return this.request<{ ok: boolean; runtimeVersion: string; pid: number }>("GET", "/health");
  }
  listPeriodicReminders(q?: string) {
    return this.request<{ reminders: PeriodicReminder[] }>("GET", `/periodic-reminders${toQuery({ q })}`);
  }
  previewPeriodicReminder(input: CreatePeriodicReminderInput) {
    return this.request<{ config: CreatePeriodicReminderInput; summary: string; nextFireAt: string | null }>("POST", "/periodic-reminders/preview", input);
  }
  getPeriodicReminder(id: string) {
    return this.request<{ reminder: PeriodicReminder }>("GET", `/periodic-reminders/${encodeURIComponent(id)}`);
  }
  createPeriodicReminder(input: CreatePeriodicReminderInput, opts?: RequestOptions) {
    return this.request<{ reminder: PeriodicReminder }>("POST", "/periodic-reminders", input, opts);
  }
  updatePeriodicReminder(id: string, input: UpdatePeriodicReminderInput, opts?: RequestOptions) {
    return this.request<{ reminder: PeriodicReminder }>("PATCH", `/periodic-reminders/${encodeURIComponent(id)}`, input, opts);
  }
  periodicAction(id: string, input: PeriodicActionInput, opts?: RequestOptions) {
    return this.request<{ reminder?: PeriodicReminder; deleted?: boolean; id?: string }>("POST", `/periodic-reminders/${encodeURIComponent(id)}/action`, input, opts);
  }
  /** The user was away from the computer for `minutes`: habit reminders count it as a break. */
  periodicAway(minutes: number) {
    return this.request<{ reset: string[] }>("POST", "/periodic-reminders/away", { minutes });
  }
  periodicOccurrences(id: string) {
    return this.request<{ occurrences: PeriodicOccurrence[] }>("GET", `/periodic-reminders/${encodeURIComponent(id)}/occurrences`);
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
  /** Permanently removes the task, its reminders and its attachments. Returns the task as it was. */
  deleteTask(id: string, body: VersionedAction = {}) {
    return this.request<{ deleted: true; task: Task }>("DELETE", `/tasks/${encodeURIComponent(id)}`, body);
  }
  skipTask(id: string, body: VersionedAction = {}, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/skip`, body, opts);
  }
  snoozeTask(id: string, body: SnoozeInput = {}, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/snooze`, body, opts);
  }
  listAttachments(id: string) {
    return this.request<{ attachments: Attachment[] }>("GET", `/tasks/${encodeURIComponent(id)}/attachments`);
  }
  addAttachments(id: string, input: AddAttachmentsInput, opts?: RequestOptions) {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(id)}/attachments`, input, opts);
  }
  getAttachment(id: string, attachmentId: string) {
    return this.request<{ attachment: Attachment; dataBase64: string }>("GET", `/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`);
  }
  removeAttachment(id: string, attachmentId: string, body: VersionedAction = {}) {
    return this.request<{ task: Task }>("DELETE", `/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, body);
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
    return this.request<{
      authorization: string;
      available: boolean;
      detail: string | null;
      /** macOS has already recorded a decision, so it will not prompt again. */
      needsSystemSettings: boolean;
    }>("POST", "/notifications/request-authorization", {});
  }
  /** Opens System Settings › Notifications so the user can enable the helper by hand. */
  openNotificationSettings() {
    return this.request<{ ok: boolean; url: string | null }>("POST", "/notifications/open-settings", {});
  }
  testNotification(body: { title?: string; body?: string } = {}) {
    return this.request<{ ok: boolean; channel: string }>("POST", "/notifications/test", body);
  }

  /**
   * Subscribe to server-sent events. Resolves when the stream ends or the
   * signal aborts; callers reconnect themselves (and re-sync state).
   */
  async events(onEvent: (ev: RuntimeEvent) => void, opts: { signal?: AbortSignal; lastEventId?: number } = {}): Promise<void> {
    if (!this.httpOptions) throw new Error("Subscribe through the native desktop bridge");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.httpOptions.token}`, Accept: "text/event-stream" };
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

export interface Board { context: ContextInfo; today: TodayResult; next: NextResult; all: Task[]; upcoming: Task[]; ordering: OrderingState; }
export interface OrderResult { ordering: OrderingState; undoToken: string; }
export interface PeriodicClaim { occurrenceId: string; round: number; token: string; }
