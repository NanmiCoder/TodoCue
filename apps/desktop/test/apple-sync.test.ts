import { describe, expect, it } from "vitest";
import type { AppleSyncChannel, AppleSyncStatus } from "../src/bridge.js";
import { anyEnabled, channelNotice, hostErrorText, recommendation, statusLine, unavailableText } from "../src/appleSync.js";

const off: AppleSyncChannel = { enabled: false, access: "notDetermined", changing: false };
function status(patch: Partial<AppleSyncStatus> = {}): AppleSyncStatus {
  return { event: off, reminder: off, syncing: false, connected: true, ...patch };
}
const time = (instant: string) => instant.slice(11, 16);

describe("Apple sync settings copy", () => {
  it("explains why the switches are missing before the helper reports", () => {
    expect(unavailableText(null, "zh-CN")).toBe("正在读取同步状态…");
    expect(unavailableText({ available: false, running: false, status: null }, "en")).toMatch(/does not include Apple sync/);
    expect(unavailableText({ available: true, running: false, status: null }, "zh-CN")).toBe("同步服务正在启动…");
    expect(unavailableText({ available: true, running: true, status: status() }, "zh-CN")).toBeNull();
  });

  it("recommends Reminders alone and warns when both are on", () => {
    expect(recommendation(status({ reminder: { ...off, enabled: true } }), "zh-CN")).toEqual({
      warning: false, text: expect.stringContaining("推荐只开「同步到提醒事项」"),
    });
    expect(recommendation(status({ event: { ...off, enabled: true }, reminder: { ...off, enabled: true } }), "en").warning).toBe(true);
  });

  it("orders the status line like the SwiftUI settings: syncing, error, last sync, waiting", () => {
    const at = "2026-10-20T09:41:00.000Z";
    expect(statusLine(status({ syncing: true, lastError: "x", lastSyncAt: at }), "zh-CN", time).text).toBe("正在同步…");
    expect(statusLine(status({ lastError: "账户不可用", lastSyncAt: at }), "zh-CN", time)).toEqual({ text: "同步出错：账户不可用", error: true });
    expect(statusLine(status({ lastSyncAt: at }), "en", time)).toEqual({ text: "Last synced 09:41", error: false });
    expect(statusLine(status({ lastError: null, lastSyncAt: null }), "zh-CN", time).text).toBe("等待连接运行时后同步");
  });

  it("puts access problems before the container, and shows a container only for a channel that is on", () => {
    const container = { title: "TodoCue", sourceTitle: "iCloud", isICloud: true };
    expect(channelNotice("reminder", { ...off, access: "writeOnly" }, "zh-CN")?.kind).toBe("writeOnly");
    expect(channelNotice("reminder", { ...off, enabled: true, access: "writeOnly", container }, "zh-CN")?.kind).toBe("needsAccess");
    expect(channelNotice("event", { ...off, access: "denied" }, "en")).toEqual({ kind: "denied", text: "macOS has not allowed access" });
    expect(channelNotice("reminder", { ...off, access: "granted", container }, "zh-CN")).toBeNull();
    expect(channelNotice("reminder", { ...off, enabled: true, access: "granted", container }, "zh-CN"))
      .toEqual({ kind: "container", text: "「TodoCue」· iCloud", warning: null });
  });

  it("offers to ask for access when a switch is on without it", () => {
    for (const access of ["notDetermined", "writeOnly"] as const) {
      expect(channelNotice("reminder", { ...off, enabled: true, access }, "zh-CN")?.kind).toBe("needsAccess");
    }
    expect(channelNotice("reminder", { ...off, enabled: false, access: "notDetermined" }, "zh-CN")).toBeNull();
    expect(channelNotice("reminder", { ...off, enabled: true, access: "denied" }, "zh-CN")?.kind).toBe("denied");
    const waiting = status({ reminder: { ...off, enabled: true, access: "notDetermined" }, lastSyncAt: "2026-10-20T09:41:00.000Z" });
    expect(statusLine(waiting, "zh-CN", time)).toEqual({ text: "等待授权后同步", error: true });
    const partly = status({ event: { ...off, enabled: true, access: "granted" }, reminder: { ...off, enabled: true, access: "notDetermined" } });
    expect(statusLine(partly, "zh-CN", time).text).toBe("等待连接运行时后同步");
  });

  it("warns that a container outside iCloud never reaches the phone", () => {
    const local = { title: "TodoCue", sourceTitle: "我的 Mac", isICloud: false };
    const notice = channelNotice("event", { ...off, enabled: true, access: "granted", container: local }, "zh-CN");
    expect(notice?.kind === "container" && notice.warning).toMatch(/未开启 iCloud 日历/);
    const reminders = channelNotice("reminder", { ...off, enabled: true, access: "granted", container: local }, "en");
    expect(reminders?.kind === "container" && reminders.warning).toMatch(/iCloud Reminders is off/);
  });

  it("translates the host's own refusals and passes the helper's messages through", () => {
    expect(hostErrorText("Apple sync is not running", "zh-CN")).toBe("同步服务正在启动，请稍后再试。");
    expect(hostErrorText("Apple sync stopped unexpectedly", "en")).toMatch(/restarting/);
    expect(hostErrorText("未获得提醒事项访问权限", "en")).toBe("未获得提醒事项访问权限");
  });

  it("offers Sync now only while a channel is on", () => {
    expect(anyEnabled(null)).toBe(false);
    expect(anyEnabled(status())).toBe(false);
    expect(anyEnabled(status({ event: { ...off, enabled: true } }))).toBe(true);
  });
});
