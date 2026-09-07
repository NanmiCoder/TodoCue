import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { NotificationAuthorization } from "@todocue/shared";

const execFileP = promisify(execFile);

export interface NotificationPayload {
  /** Stable identifier; re-delivery with the same id replaces the previous notification. */
  id: string;
  title: string;
  body?: string;
  subtitle?: string;
  taskId?: string;
  thread?: string;
}

export interface NotifierStatus {
  available: boolean;
  path: string | null;
  authorization: NotificationAuthorization;
  detail: string | null;
}

export interface NotificationSink {
  /** Returns the channel used (e.g. "helper", "osascript"). Throws on failure. */
  deliver(payload: NotificationPayload): Promise<string>;
  status(): Promise<NotifierStatus>;
  requestAuthorization(): Promise<NotifierStatus>;
}

/** In-memory sink for tests. */
export class MemoryNotifier implements NotificationSink {
  delivered: NotificationPayload[] = [];
  failNext: string | null = null;
  authorization: NotificationAuthorization = "authorized";
  async deliver(payload: NotificationPayload): Promise<string> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw new Error(err);
    }
    this.delivered.push(payload);
    return "memory";
  }
  async status(): Promise<NotifierStatus> {
    return { available: true, path: null, authorization: this.authorization, detail: null };
  }
  async requestAuthorization(): Promise<NotifierStatus> {
    return this.status();
  }
}

export interface HelperNotifierOptions {
  /** Explicit helper executable path. */
  helperPath?: string;
  /** Extra candidate locations (e.g. repo build dir). */
  searchPaths?: string[];
  /** Fall back to `osascript display notification` when the helper is unavailable. */
  allowOsascriptFallback?: boolean;
  log?: (msg: string) => void;
}

export function defaultHelperCandidates(home: string): string[] {
  const rel = "TodoCueNotifier.app/Contents/MacOS/TodoCueNotifier";
  return [
    path.join(home, "bin", rel),
    path.join(os.homedir(), "Applications", rel),
    path.join("/Applications", rel),
  ];
}

/**
 * Delivers notifications through the Swift helper app (UNUserNotificationCenter),
 * with an optional osascript fallback so reminders still surface when the helper
 * is not installed.
 */
export class HelperNotifier implements NotificationSink {
  private readonly opts: HelperNotifierOptions;
  constructor(opts: HelperNotifierOptions = {}) {
    this.opts = opts;
  }

  resolveHelper(): string | null {
    const candidates = [
      process.env.TODOCUE_NOTIFIER,
      this.opts.helperPath,
      ...(this.opts.searchPaths ?? []),
    ].filter((p): p is string => !!p);
    for (const c of candidates) {
      try {
        fs.accessSync(c, fs.constants.X_OK);
        return c;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private async runHelper(args: string[], timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const helper = this.resolveHelper();
    if (!helper) throw new Error("NOTIFIER_UNAVAILABLE: TodoCueNotifier helper not found");
    const { stdout } = await execFileP(helper, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }).catch((e: unknown) => {
      const err = e as { stdout?: string; stderr?: string; message: string };
      // The helper prints a JSON line even on failure; surface it.
      const line = (err.stdout ?? "").trim().split("\n").pop();
      if (line) {
        try {
          const parsed = JSON.parse(line) as { error?: string };
          throw new Error(parsed.error ?? err.message);
        } catch (inner) {
          if (inner instanceof Error && inner.message !== err.message && !(inner instanceof SyntaxError)) throw inner;
        }
      }
      throw new Error(`helper failed: ${err.stderr?.trim() || err.message}`);
    });
    const line = stdout.trim().split("\n").pop() ?? "";
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`helper returned invalid output: ${line.slice(0, 200)}`);
    }
  }

  async deliver(payload: NotificationPayload): Promise<string> {
    const helper = this.resolveHelper();
    if (helper) {
      const args = ["deliver", "--id", payload.id, "--title", payload.title];
      if (payload.body) args.push("--body", payload.body);
      if (payload.subtitle) args.push("--subtitle", payload.subtitle);
      if (payload.taskId) args.push("--task-id", payload.taskId);
      if (payload.thread) args.push("--thread", payload.thread);
      args.push("--sound");
      const res = await this.runHelper(args);
      if (res.ok !== true) throw new Error(String(res.error ?? "helper reported failure"));
      return typeof res.channel === "string" ? res.channel : "helper";
    }
    if (this.opts.allowOsascriptFallback ?? true) {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `display notification "${esc(payload.body ?? "")}" with title "${esc(payload.title)}"${
        payload.subtitle ? ` subtitle "${esc(payload.subtitle)}"` : ""
      }`;
      await execFileP("/usr/bin/osascript", ["-e", script], { timeout: 10_000 });
      this.opts.log?.("delivered via osascript fallback (helper not installed)");
      return "osascript";
    }
    throw new Error("NOTIFIER_UNAVAILABLE: TodoCueNotifier helper not found");
  }

  async status(): Promise<NotifierStatus> {
    const helper = this.resolveHelper();
    if (!helper) {
      return {
        available: false,
        path: null,
        authorization: "unknown",
        detail: (this.opts.allowOsascriptFallback ?? true)
          ? "helper not installed; reminders fall back to osascript notifications (no click-through)"
          : "helper not installed",
      };
    }
    try {
      const res = await this.runHelper(["status"], 10_000);
      return {
        available: true,
        path: helper,
        authorization: normalizeAuth(res.authorization),
        detail: typeof res.alertStyle === "string" ? `alert style: ${res.alertStyle}` : null,
      };
    } catch (e) {
      return { available: false, path: helper, authorization: "unknown", detail: (e as Error).message };
    }
  }

  async requestAuthorization(): Promise<NotifierStatus> {
    const helper = this.resolveHelper();
    if (!helper) return this.status();
    try {
      const res = await this.runHelper(["request"], 120_000);
      return {
        available: true,
        path: helper,
        authorization: normalizeAuth(res.authorization),
        detail: typeof res.alertStyle === "string" ? `alert style: ${res.alertStyle}` : null,
      };
    } catch (e) {
      return { available: true, path: helper, authorization: "unknown", detail: (e as Error).message };
    }
  }
}

function normalizeAuth(v: unknown): NotificationAuthorization {
  switch (v) {
    case "authorized":
    case "provisional":
    case "denied":
    case "notDetermined":
      return v;
    default:
      return "unknown";
  }
}
