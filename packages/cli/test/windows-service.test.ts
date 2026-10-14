import { describe, it, expect } from "vitest";
import { taskXml, windowsQuote, taskName } from "../src/windows-service.js";
describe("Windows user runtime contract", () => {
  it("quotes trailing separators and quotes without shell interpolation", () => {
    expect(windowsQuote("C:\\My Tasks\\")).toBe('"C:\\My Tasks\\\\"');
    expect(windowsQuote('title"value')).toBe('"title\\"value"');
  });
  it("runs as the current user, on batteries, with bounded restart and no double instance", () => {
    const xml = taskXml({ home: "C:\\用户 & 工作\\TodoCue", nodePath: "node.exe", cliEntry: "index.js", hostPath: "C:\\App & Data\\host.exe", notifierPath: "notifier.exe" }, "S-1-5-21-123-456-1001");
    expect(xml).toContain("InteractiveToken"); expect(xml).toContain("LeastPrivilege"); expect(xml).toContain("IgnoreNew");
    expect(xml).toContain("StopIfGoingOnBatteries>false"); expect(xml).toContain("用户 &amp; 工作");
    expect(() => taskXml({ home: "", nodePath: "", cliEntry: "", hostPath: "", notifierPath: "" }, "<invalid>")).toThrow();
  });
  it("isolates separate data homes into separate service identities", () => {
    expect(taskName("one")).toBe(taskName("one")); expect(taskName("one")).not.toBe(taskName("two"));
  });
});
