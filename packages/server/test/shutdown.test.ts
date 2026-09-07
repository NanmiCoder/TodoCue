import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryNotifier } from "@todocue/engine";
import { startRuntime } from "../src/runtime.js";
import { silentLogger } from "../src/logger.js";

it("closes active app event streams before shutting down for an update", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-shutdown-"));
  const runtime = await startRuntime({ home, memory: true, notifier: new MemoryNotifier(), logger: silentLogger });
  const controller = new AbortController();
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(`${runtime.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${runtime.token}` }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = (async () => { while (!(await reader.read()).done) { /* drain */ } })();
    stopping = runtime.stop();
    const result = await Promise.race([
      Promise.all([stopping, ended]).then(() => "closed"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timeout"), 1500); }),
    ]);
    expect(result).toBe("closed");
  } finally {
    clearTimeout(timer);
    controller.abort();
    await (stopping ?? runtime.stop());
    fs.rmSync(home, { recursive: true, force: true });
  }
});
