import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, type ZodType } from "zod";
import {
  API_PREFIX,
  CreateSeriesInput,
  CreateTaskInput,
  ErrorCodes,
  ListRemindersQuery,
  ListTasksQuery,
  RUNTIME_VERSION,
  SnoozeInput,
  TodoCueError,
  UpdateTaskInput,
  VersionedAction,
  isTodoCueError,
  type DoctorReport,
  type RuntimeEvent,
} from "@todocue/shared";
import type { NotificationSink, Scheduler, TaskEngine } from "@todocue/engine";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";

export interface AppOptions {
  engine: TaskEngine;
  notifier: NotificationSink;
  scheduler?: Scheduler;
  token: string;
  logger?: Logger;
  /** Static facts for /doctor. */
  doctorInfo: () => Pick<DoctorReport, "home" | "databasePath" | "schemaVersion" | "baseUrl">;
  extraChecks?: () => Promise<DoctorReport["checks"]> | DoctorReport["checks"];
}

interface SseClient {
  reply: FastifyReply;
  id: number;
}

const EVENT_BUFFER = 500;

export function buildApp(opts: AppOptions): FastifyInstance {
  const { engine, notifier, token } = opts;
  const log = opts.logger ?? silentLogger;
  const startedAt = Date.now();
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  // ---- recent event ring buffer for Last-Event-ID replay ----
  const recent: RuntimeEvent[] = [];
  const sseClients = new Set<SseClient>();
  let sseClientSeq = 0;
  engine.onEvent((ev) => {
    recent.push(ev);
    if (recent.length > EVENT_BUFFER) recent.shift();
    const frame = formatSse(ev);
    for (const c of sseClients) {
      try {
        c.reply.raw.write(frame);
      } catch {
        sseClients.delete(c);
      }
    }
  });
  const pingTimer = setInterval(() => {
    for (const c of sseClients) {
      try {
        c.reply.raw.write(": ping\n\n");
      } catch {
        sseClients.delete(c);
      }
    }
  }, 15_000);
  pingTimer.unref?.();
  // Close hijacked SSE sockets before Fastify waits for active connections.
  // onClose is too late: a visible app would otherwise keep shutdown pending.
  app.addHook("preClose", async () => {
    clearInterval(pingTimer);
    for (const c of sseClients) {
      try {
        c.reply.raw.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  });

  // ---- optional request log (TODOCUE_LOG_HTTP=1) ----
  if (process.env.TODOCUE_LOG_HTTP === "1") {
    app.addHook("onResponse", async (req, reply) => {
      log.info(`${req.method} ${req.url} -> ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`);
    });
  }

  // ---- auth ----
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === `${API_PREFIX}/health` || req.url === "/") return;
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.query as { token?: string })?.token;
    if (!presented || !timingSafeEqualStr(presented, token)) {
      reply.code(401).send(new TodoCueError(ErrorCodes.UNAUTHORIZED, "missing or invalid token").toBody());
      return reply;
    }
  });

  // ---- error mapping ----
  app.setErrorHandler((err, _req, reply) => {
    if (isTodoCueError(err)) {
      reply.code(err.httpStatus).send(err.toBody());
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send(
        new TodoCueError(ErrorCodes.VALIDATION_ERROR, "invalid input", err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))).toBody(),
      );
      return;
    }
    const anyErr = err as { statusCode?: number; message?: string; code?: string };
    if (anyErr.statusCode && anyErr.statusCode < 500) {
      reply.code(anyErr.statusCode).send(new TodoCueError(ErrorCodes.VALIDATION_ERROR, anyErr.message ?? "bad request").toBody());
      return;
    }
    log.error(`unhandled error: ${(err as Error).stack ?? String(err)}`);
    reply.code(500).send(new TodoCueError(ErrorCodes.INTERNAL, "internal error").toBody());
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(new TodoCueError(ErrorCodes.NOT_FOUND, `route ${req.method} ${req.url} not found`).toBody());
  });

  // ---- idempotency (POST/PATCH with Idempotency-Key) ----
  app.addHook("preHandler", async (req, reply) => {
    const key = headerString(req, "idempotency-key");
    if (!key || (req.method !== "POST" && req.method !== "PATCH")) return;
    const hash = requestHash(req);
    const existing = engine.idempotencyGet(scopedKey(req, key));
    if (existing) {
      if (existing.requestHash !== hash) {
        reply
          .code(422)
          .send(new TodoCueError(ErrorCodes.IDEMPOTENCY_MISMATCH, "Idempotency-Key was already used with a different request").toBody());
        return reply;
      }
      reply.header("Idempotent-Replayed", "true").code(existing.statusCode).type("application/json").send(existing.body);
      return reply;
    }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const key = headerString(req, "idempotency-key");
    if (!key || (req.method !== "POST" && req.method !== "PATCH")) return payload;
    if (reply.getHeader("Idempotent-Replayed")) return payload;
    if (reply.statusCode >= 200 && reply.statusCode < 300 && typeof payload === "string") {
      engine.idempotencyPut(scopedKey(req, key), requestHash(req), reply.statusCode, payload);
    }
    return payload;
  });

  const parse = <T>(schema: ZodType<T>, value: unknown): T => schema.parse(value ?? {});
  const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;
  const normalizeQuery = (q: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((q ?? {}) as Record<string, unknown>)) {
      if (typeof v === "string" && v.includes(",") && (k === "status")) out[k] = v.split(",");
      else out[k] = v;
    }
    return out;
  };

  // ---- routes ----
  app.get("/", async () => ({ name: "todocue", runtimeVersion: RUNTIME_VERSION }));
  app.get(`${API_PREFIX}/health`, async () => ({ ok: true, runtimeVersion: RUNTIME_VERSION, pid: process.pid }));
  app.get(`${API_PREFIX}/context`, async () => engine.context());

  app.get(`${API_PREFIX}/tasks`, async (req) => ({ tasks: engine.listTasks(parse(ListTasksQuery, normalizeQuery(req.query))) }));
  app.post(`${API_PREFIX}/tasks`, async (req, reply) => {
    const res = engine.createTask(parse(CreateTaskInput, req.body));
    reply.code(201);
    return { task: res.task, series: res.series };
  });
  app.get(`${API_PREFIX}/tasks/:id`, async (req) => engine.getTaskDetail(idOf(req)));
  app.patch(`${API_PREFIX}/tasks/:id`, async (req) => ({ task: engine.updateTask(idOf(req), parse(UpdateTaskInput, req.body)) }));
  app.post(`${API_PREFIX}/tasks/:id/complete`, async (req) => ({ task: engine.completeTask(idOf(req), parse(VersionedAction, req.body)) }));
  app.post(`${API_PREFIX}/tasks/:id/reopen`, async (req) => ({ task: engine.reopenTask(idOf(req), parse(VersionedAction, req.body)) }));
  app.post(`${API_PREFIX}/tasks/:id/cancel`, async (req) => ({ task: engine.cancelTask(idOf(req), parse(VersionedAction, req.body)) }));
  app.post(`${API_PREFIX}/tasks/:id/skip`, async (req) => ({ task: engine.skipTask(idOf(req), parse(VersionedAction, req.body)) }));
  app.post(`${API_PREFIX}/tasks/:id/snooze`, async (req) => ({ task: engine.snoozeTask(idOf(req), parse(SnoozeInput, req.body)) }));

  app.get(`${API_PREFIX}/today`, async () => engine.todayView());
  app.get(`${API_PREFIX}/next`, async () => engine.nextView());
  app.get(`${API_PREFIX}/projects`, async () => ({ projects: engine.projects() }));

  app.post(`${API_PREFIX}/series`, async (req, reply) => {
    const res = engine.createSeries(parse(CreateSeriesInput, req.body));
    reply.code(201);
    return res;
  });
  app.get(`${API_PREFIX}/series`, async (req) => {
    const status = (req.query as { status?: string }).status;
    if (status && status !== "active" && status !== "stopped") throw TodoCueError.validation("status must be active or stopped");
    return { series: engine.listSeries(status ? { status: status as "active" | "stopped" } : {}) };
  });
  app.get(`${API_PREFIX}/series/:id`, async (req) => ({ series: engine.getSeries(idOf(req)), tasks: engine.getSeriesTasks(idOf(req)) }));
  app.post(`${API_PREFIX}/series/:id/stop`, async (req) => engine.stopSeries(idOf(req), parse(VersionedAction, req.body)));

  app.get(`${API_PREFIX}/reminders`, async (req) => ({ reminders: engine.listReminders(parse(ListRemindersQuery, normalizeQuery(req.query))) }));

  app.get(`${API_PREFIX}/export`, async () => engine.exportBundle());

  app.get(`${API_PREFIX}/doctor`, async () => {
    const info = opts.doctorInfo();
    const n = await notifier.status();
    const counts = engine.counts();
    const checks: DoctorReport["checks"] = [
      { name: "database", ok: true, level: "ok", detail: `${info.databasePath} (schema v${info.schemaVersion})` },
      {
        name: "notifier",
        ok: n.available,
        level: n.available ? "ok" : "warn",
        detail: n.available ? `helper at ${n.path}` : (n.detail ?? "helper not available"),
      },
      {
        name: "notificationAuthorization",
        ok: n.authorization === "authorized" || n.authorization === "provisional",
        level: n.authorization === "authorized" || n.authorization === "provisional" ? "ok" : n.authorization === "denied" ? "error" : "warn",
        detail:
          n.authorization === "denied"
            ? "notifications denied in System Settings > Notifications > TodoCueNotifier; tasks still work, reminders will not show"
            : n.authorization === "notDetermined"
              ? "not requested yet; run `todocue doctor --request-notifications`"
              : `authorization: ${n.authorization}`,
      },
      {
        name: "failedReminders",
        ok: counts.failedReminders === 0,
        level: counts.failedReminders === 0 ? "ok" : "warn",
        detail: `${counts.failedReminders} failed reminder(s); see todocue reminders --status failed`,
      },
      ...((await opts.extraChecks?.()) ?? []),
    ];
    const report: DoctorReport = {
      runtimeVersion: RUNTIME_VERSION,
      nodeVersion: process.version,
      home: info.home,
      databasePath: info.databasePath,
      schemaVersion: info.schemaVersion,
      timezone: engine.timezone,
      baseUrl: info.baseUrl,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      notifier: { path: n.path, available: n.available, authorization: n.authorization, detail: n.detail },
      counts,
      checks,
    };
    return report;
  });

  app.post(`${API_PREFIX}/notifications/request-authorization`, async () => {
    const s = await notifier.requestAuthorization();
    return { authorization: s.authorization, available: s.available, detail: s.detail };
  });
  app.post(`${API_PREFIX}/notifications/test`, async (req) => {
    const body = (req.body ?? {}) as { title?: string; body?: string };
    try {
      const channel = await notifier.deliver({
        id: `todocue-test-${Date.now()}`,
        title: body.title ?? "TodoCue 测试通知",
        body: body.body ?? "通知已正常送达。",
        thread: "todocue.test",
      });
      return { ok: true, channel };
    } catch (e) {
      throw new TodoCueError(ErrorCodes.UNAVAILABLE, (e as Error).message);
    }
  });

  // ---- SSE ----
  app.get(`${API_PREFIX}/events`, async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`retry: 2000\n: connected\n\n`);
    const lastId = headerString(req, "last-event-id");
    const client: SseClient = { reply, id: ++sseClientSeq };
    if (lastId && /^\d+$/.test(lastId)) {
      const since = Number.parseInt(lastId, 10);
      for (const ev of recent) if (ev.seq > since) reply.raw.write(formatSse(ev));
    }
    // Always announce the runtime so clients know which process they talk to.
    reply.raw.write(
      formatSse({ seq: 0, type: "runtime.started", at: new Date().toISOString(), id: String(process.pid) }, false),
    );
    sseClients.add(client);
    req.raw.on("close", () => sseClients.delete(client));
    // Hijack the reply: Fastify must not end the response.
    reply.hijack();
  });

  return app;
}

function formatSse(ev: RuntimeEvent, withId = true): string {
  return `${withId ? `id: ${ev.seq}\n` : ""}event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function headerString(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function scopedKey(req: FastifyRequest, key: string): string {
  return `${req.method} ${req.url.split("?")[0]} ${key}`;
}

function requestHash(req: FastifyRequest): string {
  return createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
