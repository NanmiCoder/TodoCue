import fs from "node:fs";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(opts: { file?: string; stdout?: boolean } = {}): Logger {
  let stream: fs.WriteStream | null = null;
  if (opts.file) {
    try {
      stream = fs.createWriteStream(opts.file, { flags: "a" });
    } catch {
      stream = null;
    }
  }
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    if (stream) stream.write(line);
    if (opts.stdout ?? true) (level === "error" ? process.stderr : process.stdout).write(line);
  };
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
