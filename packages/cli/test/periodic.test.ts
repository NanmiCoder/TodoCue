import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { parsePeriodicInterval, parsePeriodicWindows, registerPeriodicCommands } from "../src/commands/periodic.js";
import type { TodoCueClient } from "@todocue/server";

describe("periodic CLI", () => {
  it("parses intervals and multiple windows without guessing natural language", () => {
    expect(parsePeriodicInterval("30m")).toBe(30); expect(parsePeriodicInterval("1h")).toBe(60);
    expect(parsePeriodicInterval("15")).toBe(15);
    expect(() => parsePeriodicInterval("30minutes")).toThrow();
    expect(parsePeriodicWindows(["09:00-12:00", "13:00-24:00"])).toEqual([{ start: "09:00", end: "12:00" }, { start: "13:00", end: "24:00" }]);
    expect(() => parsePeriodicWindows(["work hours"])).toThrow();
  });
  it("creates with one call, preserves retry key and leaves server defaults unspecified", async () => {
    const create = vi.fn().mockResolvedValue({ reminder: { id: "p_1", title: "活动" } });
    const program = new Command();
    registerPeriodicCommands(program, { client: () => ({ createPeriodicReminder: create } as unknown as TodoCueClient), out: () => ({ json: true }) });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["periodic", "add", "活动", "--every", "30m", "--idempotency-key", "same-key"], { from: "user" });
      expect(create).toHaveBeenCalledExactlyOnceWith({ title: "活动", intervalMinutes: 30 }, { idempotencyKey: "same-key" });
    } finally { write.mockRestore(); }
  });
  it("maps specified weekdays, split windows and completion mode in one call", async () => {
    const create = vi.fn().mockResolvedValue({ reminder: {} });
    const program = new Command();
    registerPeriodicCommands(program, { client: () => ({ createPeriodicReminder: create } as unknown as TodoCueClient), out: () => ({ json: true }) });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["periodic", "add", "喝水", "--every", "1h", "--weekdays", "mon,wed,sat", "--between", "09:00-12:00", "--between", "13:00-18:00", "--mode", "after_completion"], { from: "user" });
      expect(create.mock.calls[0]![0]).toEqual({ title: "喝水", intervalMinutes: 60, weekdays: [1, 3, 6],
        windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "18:00" }], mode: "after_completion" });
    } finally { write.mockRestore(); }
  });
});
