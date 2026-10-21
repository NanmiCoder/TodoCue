import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/commands/mcp.js";
import type { TodoCueClient } from "@todocue/server";

type Message = { id?: number; result?: { tools?: { name: string; description?: string; inputSchema: { properties: object } }[] } };

/** A transport that talks to the server in-process: enough to run initialize and tools/list. */
async function listTools(): Promise<NonNullable<NonNullable<Message["result"]>["tools"]>> {
  const server = buildMcpServer(() => ({}) as TodoCueClient);
  const waiting = new Map<number, (message: Message) => void>();
  const transport = {
    onmessage: undefined as undefined | ((message: unknown) => void),
    onclose: undefined as undefined | (() => void),
    onerror: undefined as undefined | ((error: Error) => void),
    async start() {},
    async close() { transport.onclose?.(); },
    async send(message: Message) { if (message.id !== undefined) waiting.get(message.id)?.(message); },
  };
  await server.connect(transport as never);
  const call = (id: number, method: string, params: object) =>
    new Promise<Message>((resolve) => {
      waiting.set(id, resolve);
      transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
    });
  await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = (await call(2, "tools/list", {})).result!.tools!;
  await server.close();
  return tools;
}

describe("periodic MCP tools describe the defaults the runtime really applies", () => {
  it("says the default is habit timing with a follow-up, and exposes followUpMinutes", async () => {
    const tools = await listTools();
    const create = tools.find((tool) => tool.name === "todocue_create_periodic_reminder")!;
    expect(create.description).toContain("mode=after_completion");
    expect(create.description).toContain("followUpMinutes=10");
    expect(create.description).not.toMatch(/Defaults:[^.]*fixed slots/);
    expect(Object.keys(create.inputSchema.properties)).toContain("followUpMinutes");
    const update = tools.find((tool) => tool.name === "todocue_update_periodic_reminder")!;
    expect(Object.keys(update.inputSchema.properties)).toContain("followUpMinutes");
  });
});
