import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "@todocue/shared";

export interface RuntimePaths {
  home: string;
  database: string;
  backups: string;
  logs: string;
  logFile: string;
  bin: string;
  token: string;
  connection: string;
  pid: string;
  launchAgentLabel: string;
  launchAgentPlist: string;
}

export function resolveHome(explicit?: string): string {
  const raw = explicit ?? process.env.TODOCUE_HOME ?? path.join(os.homedir(), ".todocue");
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

export function runtimePaths(home = resolveHome()): RuntimePaths {
  return {
    home,
    database: path.join(home, "todocue.sqlite"),
    backups: path.join(home, "backups"),
    logs: path.join(home, "logs"),
    logFile: path.join(home, "logs", "runtime.log"),
    bin: path.join(home, "bin"),
    token: path.join(home, "token"),
    connection: path.join(home, "connection.json"),
    pid: path.join(home, "runtime.pid"),
    launchAgentLabel: "com.todocue.runtime",
    launchAgentPlist: path.join(os.homedir(), "Library", "LaunchAgents", "com.todocue.runtime.plist"),
  };
}

export function resolvePort(explicit?: number): number {
  if (explicit) return explicit;
  const env = process.env.TODOCUE_PORT;
  if (env && /^\d+$/.test(env)) return Number.parseInt(env, 10);
  return DEFAULT_PORT;
}

export function ensureHome(paths: RuntimePaths): void {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.mkdirSync(paths.backups, { recursive: true });
  fs.mkdirSync(paths.bin, { recursive: true });
  try {
    fs.chmodSync(paths.home, 0o700);
  } catch {
    /* best effort */
  }
}

/** Read or create the persistent local API token (only the current user can read it). */
export function loadOrCreateToken(paths: RuntimePaths, generate: () => string): string {
  try {
    const t = fs.readFileSync(paths.token, "utf8").trim();
    if (t.length >= 20) return t;
  } catch {
    /* create below */
  }
  const token = generate();
  fs.writeFileSync(paths.token, token + "\n", { mode: 0o600 });
  fs.chmodSync(paths.token, 0o600);
  return token;
}

export function writeSecretJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
