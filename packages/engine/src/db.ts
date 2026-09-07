import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type SqliteDatabase = Database.Database;

export interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial",
    up(db) {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE series (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT,
          project TEXT,
          priority TEXT NOT NULL DEFAULT 'none',
          estimate_minutes INTEGER,
          rule_kind TEXT NOT NULL,
          weekdays TEXT,
          scheduled_time TEXT,
          reminder_time TEXT,
          timezone TEXT NOT NULL,
          start_date TEXT NOT NULL,
          end_date TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          stopped_at TEXT,
          generated_through TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT,
          project TEXT,
          priority TEXT NOT NULL DEFAULT 'none',
          estimate_minutes INTEGER,
          scheduled_date TEXT,
          scheduled_at TEXT,
          due_date TEXT,
          due_at TEXT,
          reminder_at TEXT,
          timezone TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'todo',
          completed_at TEXT,
          series_id TEXT REFERENCES series(id),
          occurrence_date TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX tasks_status_idx ON tasks(status);
        CREATE INDEX tasks_scheduled_idx ON tasks(scheduled_date, scheduled_at);
        CREATE INDEX tasks_due_idx ON tasks(due_date, due_at);
        CREATE INDEX tasks_completed_idx ON tasks(completed_at);
        CREATE UNIQUE INDEX tasks_series_occurrence_idx ON tasks(series_id, occurrence_date) WHERE series_id IS NOT NULL;

        CREATE TABLE reminders (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          fire_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          submitted_at TEXT,
          channel TEXT,
          next_attempt_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX reminders_pending_idx ON reminders(status, fire_at);
        CREATE INDEX reminders_task_idx ON reminders(task_id);

        CREATE TABLE idempotency (
          key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
];

export const CURRENT_SCHEMA_VERSION = migrations[migrations.length - 1]!.version;

export interface OpenOptions {
  /** File path or ":memory:". */
  path: string;
  /** Directory for pre-migration backups (ignored for in-memory). */
  backupDir?: string;
  log?: (msg: string) => void;
}

export interface OpenedDatabase {
  db: SqliteDatabase;
  path: string;
  schemaVersion: number;
  appliedMigrations: number[];
  backupPath: string | null;
}

export function openDatabase(opts: OpenOptions): OpenedDatabase {
  const isMemory = opts.path === ":memory:";
  if (!isMemory) fs.mkdirSync(path.dirname(opts.path), { recursive: true });
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[];
  const applied = new Set(rows.map((r) => r.version));
  const pending = migrations.filter((m) => !applied.has(m.version));

  let backupPath: string | null = null;
  const appliedNow: number[] = [];
  if (pending.length > 0) {
    if (!isMemory && applied.size > 0) {
      // Existing database is about to change shape: take a consistent backup first.
      const dir = opts.backupDir ?? path.join(path.dirname(opts.path), "backups");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(dir, `${path.basename(opts.path, ".sqlite")}-${stamp}-pre-v${pending[0]!.version}.sqlite`);
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      opts.log?.(`backup written to ${backupPath}`);
    }
    const runAll = db.transaction(() => {
      for (const m of pending) {
        m.up(db);
        db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
          m.version,
          m.name,
          new Date().toISOString(),
        );
        appliedNow.push(m.version);
        opts.log?.(`applied migration v${m.version} ${m.name}`);
      }
    });
    runAll();
  }
  const version = (db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number | null }).v ?? 0;
  return { db, path: opts.path, schemaVersion: version, appliedMigrations: appliedNow, backupPath };
}
