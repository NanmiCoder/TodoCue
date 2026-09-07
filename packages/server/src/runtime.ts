import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { RUNTIME_VERSION, type ConnectionInfo } from "@todocue/shared";
import {
  HelperNotifier,
  Scheduler,
  TaskEngine,
  defaultHelperCandidates,
  newSecret,
  openDatabase,
  systemClock,
  type Clock,
  type NotificationSink,
} from "@todocue/engine";
import { buildApp } from "./app.js";
import { ensureHome, loadOrCreateToken, readJsonFile, resolveHome, resolvePort, runtimePaths, writeSecretJson, type RuntimePaths } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { packagedHelper } from "./bundle.js";

export interface RuntimeOptions {
  home?: string;
  port?: number;
  host?: string;
  clock?: Clock;
  notifier?: NotificationSink;
  logger?: Logger;
  /** In-memory database (tests). */
  memory?: boolean;
  /** Scheduler tick interval override. */
  tickMs?: number;
}

export interface RunningRuntime {
  app: FastifyInstance;
  engine: TaskEngine;
  scheduler: Scheduler;
  notifier: NotificationSink;
  paths: RuntimePaths;
  baseUrl: string;
  token: string;
  stop: () => Promise<void>;
}

/** Repo-relative helper build output, used in development before `todocue install`. */
export function repoHelperCandidate(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // packages/server/dist -> repo root
    const root = path.resolve(here, "..", "..", "..");
    const p = path.join(root, "apps", "macos", "build", "TodoCueNotifier.app", "Contents", "MacOS", "TodoCueNotifier");
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export async function isRuntimeAlive(paths: RuntimePaths): Promise<ConnectionInfo | null> {
  const info = readJsonFile<ConnectionInfo>(paths.connection);
  if (!info) return null;
  try {
    const res = await fetch(`${info.baseUrl}/v1/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; pid?: number };
    return body.ok ? { ...info, pid: body.pid ?? info.pid } : null;
  } catch {
    return null;
  }
}

export async function startRuntime(opts: RuntimeOptions = {}): Promise<RunningRuntime> {
  const paths = runtimePaths(resolveHome(opts.home));
  ensureHome(paths);
  const logger = opts.logger ?? createLogger({ file: paths.logFile, stdout: true });

  if (!opts.memory) {
    const alive = await isRuntimeAlive(paths);
    if (alive && alive.pid !== process.pid) {
      throw new Error(`TodoCue runtime already running (pid ${alive.pid}) at ${alive.baseUrl}`);
    }
  }

  const opened = openDatabase({
    path: opts.memory ? ":memory:" : paths.database,
    backupDir: paths.backups,
    log: (m) => logger.info(m),
  });
  const engine = new TaskEngine({ db: opened.db, clock: opts.clock ?? systemClock, timezone: process.env.TODOCUE_TZ });
  const notifier =
    opts.notifier ??
    new HelperNotifier({
      searchPaths: [packagedHelper() ?? "", ...defaultHelperCandidates(paths.home), repoHelperCandidate() ?? ""].filter(Boolean),
      log: (m) => logger.info(m),
    });
  const scheduler = new Scheduler({ engine, notifier, tickMs: opts.tickMs, log: (m) => logger.info(m) });
  const token = opts.memory ? newSecret() : loadOrCreateToken(paths, newSecret);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.memory && opts.port === undefined ? 0 : resolvePort(opts.port);

  let baseUrl = "";
  const app = buildApp({
    engine,
    notifier,
    scheduler,
    token,
    logger,
    doctorInfo: () => ({ home: paths.home, databasePath: opened.path, schemaVersion: opened.schemaVersion, baseUrl }),
    extraChecks: () => [
      {
        name: "launchAgent",
        ok: fs.existsSync(paths.launchAgentPlist),
        level: fs.existsSync(paths.launchAgentPlist) ? "ok" : "warn",
        detail: fs.existsSync(paths.launchAgentPlist)
          ? `installed at ${paths.launchAgentPlist}`
          : "not installed; run `todocue service install` so reminders work without a terminal",
      },
    ],
  });

  await app.listen({ host, port });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  baseUrl = `http://${host}:${actualPort}`;

  if (!opts.memory) {
    const info: ConnectionInfo = { baseUrl, token, pid: process.pid, startedAt: new Date().toISOString(), runtimeVersion: RUNTIME_VERSION };
    writeSecretJson(paths.connection, info);
    fs.writeFileSync(paths.pid, `${process.pid}\n`);
  }
  scheduler.start();
  engine.pruneIdempotency();
  logger.info(`TodoCue runtime ${RUNTIME_VERSION} listening on ${baseUrl} (pid ${process.pid}, home ${paths.home}, tz ${engine.timezone})`);
  engine.emit("runtime.started", String(process.pid));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    scheduler.stop();
    await app.close();
    try {
      opened.db.close();
    } catch {
      /* ignore */
    }
    if (!opts.memory) {
      const info = readJsonFile<ConnectionInfo>(paths.connection);
      if (info?.pid === process.pid) {
        try {
          fs.unlinkSync(paths.connection);
        } catch {
          /* ignore */
        }
      }
      try {
        if (fs.readFileSync(paths.pid, "utf8").trim() === String(process.pid)) fs.unlinkSync(paths.pid);
      } catch {
        /* ignore */
      }
    }
    logger.info("runtime stopped");
  };

  return { app, engine, scheduler, notifier, paths, baseUrl, token, stop };
}
