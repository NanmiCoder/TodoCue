import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

/** Retry Tauri's observed WebView2 transport failure, never compile/hash/NSIS errors. */
export async function runWindowsBundler(command, args, { cwd, attempts = 3, retryDelayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let tail = "";
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
      const output = (stream, chunk) => {
        stream.write(chunk);
        tail = (tail + chunk.toString()).slice(-64 * 1024);
      };
      child.stdout.on("data", chunk => output(process.stdout, chunk));
      child.stderr.on("data", chunk => output(process.stderr, chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.code === 0) return;
    const transient = /failed to bundle project:[^\r\n]*\bPeer disconnected\b/.test(tail);
    if (!result.signal && transient && attempt < attempts) {
      console.warn(`Tauri download disconnected; retrying bundle (${attempt + 1}/${attempts})`);
      await setTimeout(retryDelayMs * attempt);
      continue;
    }
    const error = new Error(`Windows bundler failed (exit ${result.code ?? result.signal})`);
    Object.assign(error, result);
    throw error;
  }
}
