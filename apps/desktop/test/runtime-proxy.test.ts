import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import { MemoryNotifier } from "@todocue/engine";
import { startRuntime } from "@todocue/server";
import { runtimeProxy } from "../vite.config.js";

it("development proxy preserves JSON bodies for task and attachment DELETE actions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "todocue-proxy-regression-"));
  vi.stubEnv("TODOCUE_HOME", home);
  const runtime = await startRuntime({ home, port: 0, notifier: new MemoryNotifier(), tickMs: 60000,
    logger: { info: () => {}, warn: () => {}, error: () => {} } });
  const web = await createServer({ configFile: false, plugins: [runtimeProxy()], logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  try {
    await web.listen();
    const base = `http://127.0.0.1:${(web.httpServer!.address() as AddressInfo).port}/__runtime/v1`;
    let task = runtime.engine.createTask({ title: "Disposable proxy fixture", attachments: [{ name: "a.txt", dataBase64: "YWJj" }] }).task;
    const remove = await fetch(`${base}/tasks/${task.id}/attachments/${task.attachments[0]!.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version }),
    });
    expect(remove.status).toBe(200);
    task = (await remove.json() as { task: typeof task }).task;
    expect(task.attachments).toEqual([]);
    const deleted = await fetch(`${base}/tasks/${task.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true });
    expect(runtime.engine.listTasks({})).toEqual([]);
  } finally {
    await web.close(); await runtime.stop(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true });
  }
});
