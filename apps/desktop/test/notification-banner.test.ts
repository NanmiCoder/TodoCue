import { describe, expect, it, vi } from "vitest";
import type { DoctorReport, Reminder } from "@todocue/shared";
import {
  AUTO_REQUEST_PREFIX, autoRequestRecorded, isReminderEvent, notificationBanner, recordAutoRequest, retryResultLabel, shouldAutoRequest,
} from "../src/notificationBanner.js";
import { invisibleReason, notificationStatus, recentFailed, requestResultLabel, testResultLabel } from "../src/notification.js";

type Notifier = DoctorReport["notifier"];
type Reminders = NonNullable<DoctorReport["reminders"]>;

function doctor(notifier: Partial<Notifier> = {}, reminders?: Partial<Reminders>, checks: DoctorReport["checks"] = []): DoctorReport {
  return {
    home: "/tmp/todocue",
    notifier: { path: null, available: true, authorization: "authorized", detail: null, ...notifier },
    ...(reminders ? { reminders: { failed: 0, retrying: 0, overduePending: 0, lastError: null, lastTickAt: null, ...reminders } } : {}),
    checks,
  } as unknown as DoctorReport;
}
const zh = { platform: "macos", language: "zh-CN" } as const;
const en = { platform: "macos", language: "en" } as const;
const win = { platform: "windows", language: "zh-CN" } as const;

describe("notification strip", () => {
  it("takes no space when everything works or nothing is known", () => {
    expect(notificationBanner(null, zh)).toBeNull();
    expect(notificationBanner(undefined, zh)).toBeNull();
    expect(notificationBanner(doctor({ visible: true, alertStyle: "banner" }, {}), zh)).toBeNull();
    expect(notificationBanner(doctor({ authorization: "provisional" }), zh)).toBeNull();
    // An older runtime reports none of the new fields.
    expect(notificationBanner(doctor(), zh)).toBeNull();
  });

  it("asks for permission when it was never requested", () => {
    const banner = notificationBanner(doctor({ authorization: "notDetermined" }), zh)!;
    expect(banner).toMatchObject({ kind: "notDetermined", action: { type: "request", label: "允许通知" } });
    expect(notificationBanner(doctor({ authorization: "notDetermined" }), en)!.action).toEqual({ type: "request", label: "Allow" });
  });

  it("cannot offer a request when there is no notifier to ask", () => {
    expect(notificationBanner(doctor({ authorization: "notDetermined", available: false }), zh)).toBeNull();
    expect(notificationBanner(doctor({ authorization: "notDetermined", available: false, degraded: true }), zh)?.kind).toBe("degraded");
  });

  it("points a refusal to the system settings, with the Windows wording on Windows", () => {
    const mac = notificationBanner(doctor({ authorization: "denied" }), zh)!;
    expect(mac).toMatchObject({ kind: "denied", severity: "error", action: { type: "openSettings", label: "打开系统设置" } });
    expect(mac.message).not.toMatch(/专注助手/);
    expect(notificationBanner(doctor({ authorization: "denied" }), win)!.message).toMatch(/专注助手/);
  });

  it("says so when notifications are allowed but nothing would show", () => {
    const none = notificationBanner(doctor({ visible: false, alertStyle: "none" }), zh)!;
    expect(none).toMatchObject({ kind: "invisible", action: { type: "openSettings" } });
    expect(none.message).toContain("样式为“无”");
    const off = notificationBanner(doctor({ visible: false, alertStyle: null }), win)!;
    expect(off.kind).toBe("invisible");
    expect(off.message).toContain("通知被关了");
    // The fault is the person's setting, so it never hides behind a denied/undetermined strip.
    expect(notificationBanner(doctor({ authorization: "denied", visible: false }), zh)!.kind).toBe("denied");
  });

  it("explains an unregistered Windows toast identity without a button", () => {
    const banner = notificationBanner(doctor({ registered: false, visible: false }), win)!;
    expect(banner).toMatchObject({ kind: "unregistered", action: null });
    expect(banner.message).toMatch(/重新安装/);
  });

  it("explains the osascript fallback without a button", () => {
    const banner = notificationBanner(doctor({ degraded: true }), zh)!;
    expect(banner).toMatchObject({ kind: "degraded", severity: "warn", action: null });
    expect(banner.message).toMatch(/备用通道/);
  });

  it("offers a re-send for failed or retrying reminders and keeps the last error", () => {
    const failed = notificationBanner(doctor({}, { failed: 2, retrying: 1, lastError: { message: "boom", at: "2026-10-22T00:00:00Z" } }), zh)!;
    expect(failed).toMatchObject({ kind: "delivery", severity: "error", detail: "boom", action: { type: "retry", label: "重新发送" } });
    expect(failed.message).toBe("2 条提醒没能送达，1 条正在重试。");
    const retrying = notificationBanner(doctor({}, { retrying: 3 }), en)!;
    expect(retrying).toMatchObject({ kind: "delivery", severity: "warn", action: { type: "retry" } });
    expect(retrying.message).toBe("3 retrying.");
    expect(notificationBanner(doctor({}, { failed: 1 }), en)!.message).toBe("1 reminder failed to deliver.");
  });

  it("shows a delivery warning from the check alone, without a re-send", () => {
    const stuck = notificationBanner(doctor({}, { overduePending: 0 }, [{ name: "reminderDelivery", ok: false, level: "error", detail: "the scheduler has not run for 90s" }]), zh)!;
    expect(stuck).toMatchObject({ kind: "delivery", severity: "error", action: null, detail: "the scheduler has not run for 90s" });
    const late = notificationBanner(doctor({}, { overduePending: 2 }, [{ name: "reminderDelivery", ok: false, level: "warn", detail: "x" }]), zh)!;
    expect(late.message).toBe("2 条提醒已到点但还没发出。");
    expect(late.action).toBeNull();
    expect(notificationBanner(doctor({}, {}, [{ name: "reminderDelivery", ok: true, level: "ok", detail: "fine" }]), zh)).toBeNull();
  });

  it("ranks the fault the person can fix first", () => {
    const everything = doctor({ authorization: "authorized", visible: false, degraded: true }, { failed: 4 });
    expect(notificationBanner(everything, zh)!.kind).toBe("invisible");
    const delivery = doctor({ degraded: true }, { failed: 4 });
    expect(notificationBanner(delivery, zh)!.kind).toBe("delivery");
  });

  it("stays quiet about old failures the re-send could not reach, until there are more", () => {
    const report = doctor({}, { failed: 3 });
    expect(notificationBanner(report, { ...zh, acknowledgedFailed: 3 })).toBeNull();
    expect(notificationBanner(doctor({}, { failed: 4 }), { ...zh, acknowledgedFailed: 3 })!.message).toContain("4 条");
    // Retrying reminders are live, so they still show.
    expect(notificationBanner(doctor({}, { failed: 3, retrying: 1 }), { ...zh, acknowledgedFailed: 3 })!.message).toBe("1 条正在重试。");
  });

  it("lets the caller supply its own failed count", () => {
    expect(notificationBanner(doctor({}, { failed: 0 }), { ...zh, failedCount: 5 })!.message).toContain("5 条");
  });

  it("words the re-send result", () => {
    expect(retryResultLabel(2, "zh-CN")).toBe("已重新发送 2 条提醒");
    expect(retryResultLabel(1, "en")).toBe("Re-sending 1 reminder");
    expect(retryResultLabel(0, "zh-CN")).toMatch(/没有可重新发送/);
  });
});

describe("asking for permission once", () => {
  const fresh = doctor({ authorization: "notDetermined" });
  const idle = { alreadyRequested: false, sessionRequested: false };
  it("asks only a notifier that was never asked", () => {
    expect(shouldAutoRequest(fresh, idle)).toBe(true);
    expect(shouldAutoRequest(doctor({ authorization: "denied" }), idle)).toBe(false);
    expect(shouldAutoRequest(doctor({ authorization: "authorized" }), idle)).toBe(false);
    expect(shouldAutoRequest(doctor({ authorization: "unknown" }), idle)).toBe(false);
    expect(shouldAutoRequest(doctor({ authorization: "notDetermined", available: false }), idle)).toBe(false);
    expect(shouldAutoRequest(null, idle)).toBe(false);
  });
  it("never repeats, per device or per session", () => {
    expect(shouldAutoRequest(fresh, { alreadyRequested: true, sessionRequested: false })).toBe(false);
    expect(shouldAutoRequest(fresh, { alreadyRequested: false, sessionRequested: true })).toBe(false);
  });
  it("remembers the request per data directory", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    expect(autoRequestRecorded("/a", storage)).toBe(false);
    recordAutoRequest("/a", storage);
    expect(data.get(`${AUTO_REQUEST_PREFIX}/a`)).toBe("1");
    expect(autoRequestRecorded("/a", storage)).toBe(true);
    expect(autoRequestRecorded("/b", storage)).toBe(false);
  });
  it("survives a storage that throws", () => {
    const broken = { getItem: vi.fn(() => { throw new Error("denied"); }), setItem: vi.fn(() => { throw new Error("full"); }) };
    expect(autoRequestRecorded("/a", broken)).toBe(false);
    expect(() => recordAutoRequest("/a", broken)).not.toThrow();
    expect(autoRequestRecorded("/a", undefined)).toBe(false);
    expect(() => recordAutoRequest("/a", undefined)).not.toThrow();
  });
});

describe("settings wording", () => {
  const notifier = (extra: Partial<Notifier>) => ({ available: true, authorization: "authorized" as const, detail: null, ...extra });
  it("does not call allowed-but-invisible notifications on", () => {
    const status = notificationStatus(notifier({ visible: false, alertStyle: "none" }), "macos", "zh-CN");
    expect(status.state).toBe("invisible");
    expect(status.reason).toContain("样式为“无”");
    expect(status.actions).toEqual({ request: false, openSettings: true, test: true });
    expect(notificationStatus(notifier({ visible: false }), "windows", "en").reason).toMatch(/off in Windows Settings/);
  });
  it("shows the alert style when it is known", () => {
    expect(notificationStatus(notifier({ alertStyle: "banner", visible: true }), "macos", "zh-CN")).toMatchObject({ state: "granted", reason: "已授权，通知样式：横幅" });
    expect(notificationStatus(notifier({ alertStyle: "alert" }), "macos", "en").reason).toBe("Allowed. Style: Alerts");
    expect(notificationStatus(notifier({}), "macos", "zh-CN").reason).toBe("已授权");
  });
  it("names the app the way the system settings do", () => {
    const text = [
      notificationStatus(notifier({ authorization: "denied" }), "macos", "zh-CN").reason,
      notificationStatus(notifier({ authorization: "denied" }), "macos", "en").reason,
      invisibleReason({ alertStyle: "none" }, "macos", "zh-CN"),
      invisibleReason({ registered: false }, "windows", "en"),
    ].join("\n");
    expect(text).not.toMatch(/通知程序|notifier|TodoCueNotifier/i);
  });
  it("does not claim a test notification was delivered", () => {
    expect(testResultLabel({ ok: true, channel: "helper" }, "zh-CN")).toMatch(/已提交给系统.*专注模式和通知样式/);
    expect(testResultLabel({ ok: true, channel: "helper" }, "en")).toMatch(/Handed to the system.*Focus/);
    expect(testResultLabel({ ok: true, channel: "helper" }, "zh-CN")).not.toMatch(/送达/);
  });
  it("reports re-queued reminders after a successful request", () => {
    expect(requestResultLabel({ authorization: "authorized", needsSystemSettings: false, requeued: 2 }, "macos", "zh-CN")).toBe("已授权，正在重新发送 2 条没送达的提醒");
    expect(requestResultLabel({ authorization: "authorized", needsSystemSettings: false, requeued: 0 }, "macos", "zh-CN")).toBe("已授权");
  });
  it("lists the newest failed reminders first, at most five", () => {
    const reminder = (id: string, fireAt: string, status = "failed") => ({ id, fireAt, status }) as unknown as Reminder;
    const list = [1, 2, 3, 4, 5, 6, 7].map(n => reminder(`r${n}`, `2026-10-2${n}T00:00:00.000Z`));
    list.push(reminder("sent", "2026-10-29T00:00:00.000Z", "submitted"));
    expect(recentFailed(list).map(item => item.id)).toEqual(["r7", "r6", "r5", "r4", "r3"]);
    expect(recentFailed([])).toEqual([]);
  });
  it("refreshes the strip on reminder events only", () => {
    expect(isReminderEvent({ type: "reminder.updated" })).toBe(true);
    expect(isReminderEvent({ type: "reminder.fired" })).toBe(true);
    expect(isReminderEvent({ type: "task.updated" } as never)).toBe(false);
  });
});
