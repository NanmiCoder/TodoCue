import { describe, expect, it } from "vitest";
import type { Task } from "@todocue/shared";
import { clockTime, dayLabel, instantLabel, ruleLabel } from "../src/dates.js";
import { describeError } from "../src/errors.js";
import {
  dismissErrors,
  dismissToast,
  initialToasts,
  moveMessage,
  showToast,
  toastDuration,
  undoForShortcut,
} from "../src/toast.js";
import {
  completedDays,
  COMPLETED_MAX,
  COMPLETED_PAGE,
  growWindow,
  hasMore,
  matchingCompleted,
  probe,
} from "../src/completed.js";
import { nextFireLabel, nextWindow, periodicStateLabel, validatePeriodic } from "../src/periodic.js";
import { detectPlatform, formatShortcut, isEditable, isPrimaryModifier } from "../src/platform.js";
import { notificationStatus, requestResultLabel, testResultLabel } from "../src/notification.js";
import { draftPayload, isoWeekday, newDraft, startRepeat, validateDraft } from "../src/drafts.js";

describe("date labels follow the native client", () => {
  const today = "2026-10-17";
  it("uses relative words near today", () => {
    expect(dayLabel("2026-10-17", "zh-CN", today)).toBe("今天");
    expect(dayLabel("2026-10-18", "zh-CN", today)).toBe("明天");
    expect(dayLabel("2026-10-16", "zh-CN", today)).toBe("昨天");
    expect(dayLabel("2026-10-18", "en", today)).toBe("Tomorrow");
    expect(dayLabel("2026-10-16", "en", today)).toBe("Yesterday");
  });
  it("adds weekday, and the year only when it is not the current one", () => {
    expect(dayLabel("2026-10-19", "zh-CN", today)).toBe("10月19日周一");
    expect(dayLabel("2026-10-19", "en", today)).toBe("Mon, Oct 19");
    expect(dayLabel("2027-01-04", "zh-CN", today)).toContain("2027");
    expect(dayLabel("2027-01-04", "en", today)).toContain("2027");
  });
  it("handles empty and malformed input without throwing", () => {
    expect(dayLabel("", "zh-CN", today)).toBe("未安排");
    expect(dayLabel("", "en", today)).toBe("Unscheduled");
    expect(dayLabel("not-a-date", "en", today)).toBe("not-a-date");
  });
  it("moves across month and year boundaries", () => {
    expect(dayLabel("2027-01-01", "zh-CN", "2026-12-31")).toBe("明天");
    expect(dayLabel("2026-12-31", "zh-CN", "2027-01-01")).toBe("昨天");
  });
  it("labels instants: today shows only the time, tomorrow says so", () => {
    const zone = "Asia/Shanghai";
    expect(instantLabel("2026-10-17T06:30:00.000Z", zone, "zh-CN", today, false)).toBe("14:30");
    expect(instantLabel("2026-10-18T06:30:00.000Z", zone, "zh-CN", today, false)).toBe("明天 14:30");
    expect(instantLabel("2026-10-18T06:30:00.000Z", zone, "en", today, false)).toBe("Tomorrow 14:30");
    expect(instantLabel("2026-10-20T06:30:00.000Z", zone, "zh-CN", today, false)).toBe("10月20日 14:30");
    expect(instantLabel("2027-02-03T06:30:00.000Z", zone, "zh-CN", today, false)).toContain("2027");
  });
  it("lets the system region choose 12 or 24 hours", () => {
    const instant = "2026-10-17T06:30:00.000Z";
    expect(clockTime(instant, "Asia/Shanghai", "en", false)).toBe("14:30");
    expect(clockTime(instant, "Asia/Shanghai", "en", true)).toMatch(/2:30\s?PM/);
  });
  it("names the weekdays of a weekly rule", () => {
    expect(ruleLabel({ kind: "daily" }, "zh-CN")).toBe("每日");
    expect(ruleLabel({ kind: "weekly", weekdays: [3, 1] }, "zh-CN")).toBe("每周 一、三");
    expect(ruleLabel({ kind: "weekly", weekdays: [3, 1] }, "en")).toBe("Weekly Mon, Wed");
  });
});

describe("toast state machine", () => {
  it("replaces the visible toast and gives each an id", () => {
    const first = showToast(initialToasts, { message: "a" });
    const second = showToast(first, { message: "b", kind: "error" });
    expect(first.current).toMatchObject({ id: 1, kind: "info" });
    expect(second.current).toMatchObject({ id: 2, kind: "error", message: "b" });
  });
  it("only dismisses by its own id, so a stale timer cannot close a newer toast", () => {
    const first = showToast(initialToasts, { message: "a" });
    const second = showToast(first, { message: "b" });
    expect(dismissToast(second, 1).current?.id).toBe(2);
    expect(dismissToast(second, 2).current).toBeNull();
    expect(dismissToast(second).current).toBeNull();
  });
  it("clears errors but leaves ordinary messages", () => {
    expect(dismissErrors(showToast(initialToasts, { message: "x", kind: "error" })).current).toBeNull();
    expect(dismissErrors(showToast(initialToasts, { message: "x" })).current?.message).toBe("x");
  });
  it("keeps undo toasts longer than plain ones", () => {
    expect(toastDuration({})).toBe(5000);
    expect(toastDuration({ undo: { kind: "order", token: "t" } })).toBe(10000);
  });
  it("hands the undo to the shortcut unless a text field is being edited", () => {
    const state = showToast(initialToasts, { message: "done", undo: { kind: "reopen", taskId: "1", version: 2 } });
    expect(undoForShortcut(state, false)).toMatchObject({ kind: "reopen" });
    expect(undoForShortcut(state, true)).toBeNull();
    expect(undoForShortcut(showToast(initialToasts, { message: "x" }), false)).toBeNull();
  });
  it("words a drag outcome by what changed", () => {
    expect(moveMessage({ view: "all", sourceGroup: "A", targetGroup: "A" }, "zh-CN", "")).toBe("已调整执行顺序");
    expect(moveMessage({ view: "all", sourceGroup: "A", targetGroup: "B" }, "zh-CN", "")).toBe("已移至「B」");
    expect(moveMessage({ view: "all", sourceGroup: "A", targetGroup: "" }, "zh-CN", "")).toBe("已移至「未分组」");
    expect(moveMessage({ view: "upcoming", sourceGroup: "2026-10-18", targetGroup: "2026-10-19" }, "zh-CN", "10月19日周一")).toBe(
      "已改期至 10月19日周一，截止与提醒保持原值",
    );
  });
});

describe("error wording", () => {
  it("explains conflicts and validation failures in the interface language", () => {
    expect(describeError({ code: "VERSION_CONFLICT", message: "x" }, "zh-CN")).toBe("任务已在别处修改，已刷新");
    expect(describeError({ code: "VERSION_CONFLICT" }, "en")).toMatch(/elsewhere/);
    expect(describeError({ name: "ZodError", issues: [] }, "zh-CN")).toBe("有些内容不合法，请检查后重试");
    expect(describeError(new Error("boom"), "en")).toBe("boom");
  });
});

const done = (id: string, completedAt: string, extra: Partial<Task> = {}) =>
  ({ id, title: id, project: null, notes: null, completedAt, updatedAt: completedAt, ...extra }) as unknown as Task;

describe("completed history paging and grouping", () => {
  it("probes one past the window and never above the cap", () => {
    expect(probe(COMPLETED_PAGE)).toBe(COMPLETED_PAGE + 1);
    expect(probe(COMPLETED_MAX)).toBe(COMPLETED_MAX);
  });
  it("knows whether more exist, and cannot at the ceiling", () => {
    expect(hasMore(60, 61)).toBe(true);
    expect(hasMore(60, 60)).toBe(false);
    expect(hasMore(COMPLETED_MAX, COMPLETED_MAX)).toBe(false);
    expect(growWindow(60)).toBe(120);
    expect(growWindow(990)).toBe(COMPLETED_MAX);
  });
  it("groups newest day first in the runtime zone, keeping order inside a day", () => {
    const days = completedDays(
      [
        done("c", "2026-10-17T20:00:00.000Z"),
        done("b", "2026-10-17T02:00:00.000Z"),
        done("a", "2026-10-15T02:00:00.000Z"),
      ],
      "Asia/Shanghai",
    );
    // 20:00Z is already 04:00 on the 18th in Shanghai.
    expect(days.map((day) => [day.date, day.tasks.map((task) => task.id)])).toEqual([
      ["2026-10-18", ["c"]],
      ["2026-10-17", ["b"]],
      ["2026-10-15", ["a"]],
    ]);
  });
  it("matches title, project and notes ignoring case and accents", () => {
    const tasks = [done("x", "2026-10-17T00:00:00Z", { title: "Café", project: "Home", notes: "buy Milk" })];
    expect(matchingCompleted(tasks, "cafe")).toHaveLength(1);
    expect(matchingCompleted(tasks, " MILK ")).toHaveLength(1);
    expect(matchingCompleted(tasks, "home")).toHaveLength(1);
    expect(matchingCompleted(tasks, "zzz")).toHaveLength(0);
    expect(matchingCompleted(tasks, "  ")).toHaveLength(1);
  });
});

describe("periodic reminder form", () => {
  const valid = { title: "喝水", intervalMinutes: 30, weekdays: [1, 2, 3], windows: [{ start: "09:00", end: "18:00" }], timezone: "Asia/Shanghai" };
  it("accepts a good rule", () => {
    expect(validatePeriodic(valid, "zh-CN")).toEqual({});
  });
  it("reports each field on its own", () => {
    expect(validatePeriodic({ ...valid, title: "  " }, "zh-CN").title).toBe("请输入标题");
    expect(validatePeriodic({ ...valid, intervalMinutes: 0 }, "zh-CN").interval).toBe("间隔需要为 1–1440 分钟");
    expect(validatePeriodic({ ...valid, intervalMinutes: Number.NaN }, "zh-CN").interval).toBeTruthy();
    expect(validatePeriodic({ ...valid, weekdays: [] }, "zh-CN").weekdays).toBe("至少选择一天");
    expect(validatePeriodic({ ...valid, windows: [] }, "zh-CN").windows).toBe("至少添加一个时段");
    expect(validatePeriodic({ ...valid, timezone: "Mars/Base" }, "en").timezone).toMatch(/IANA/);
  });
  it("rejects overnight, reversed and overlapping windows", () => {
    expect(validatePeriodic({ ...valid, windows: [{ start: "22:00", end: "02:00" }] }, "zh-CN").windows).toMatch(/跨午夜/);
    expect(validatePeriodic({ ...valid, windows: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "15:00" }] }, "zh-CN").windows).toBe("生效时段不能重叠");
    expect(validatePeriodic({ ...valid, windows: [{ start: "09:00", end: "24:00" }] }, "zh-CN").windows).toBeUndefined();
  });
  it("needs a window longer than the interval", () => {
    expect(validatePeriodic({ ...valid, intervalMinutes: 120, windows: [{ start: "09:00", end: "10:00" }] }, "zh-CN").interval).toBe("至少一个时段需要长于提醒间隔");
  });
  it("starts a new window where the last ended", () => {
    expect(nextWindow([{ start: "09:00", end: "12:00" }])).toEqual({ start: "12:00", end: "15:00" });
    expect(nextWindow([{ start: "20:00", end: "23:00" }])).toEqual({ start: "23:00", end: "24:00" });
    expect(nextWindow([{ start: "20:00", end: "24:00" }])).toEqual({ start: "09:00", end: "12:00" });
    expect(nextWindow([])).toEqual({ start: "09:00", end: "12:00" });
  });
  it("labels the next reminder in the rule's zone", () => {
    const now = new Date("2026-10-17T02:00:00Z");
    expect(nextFireLabel("2026-10-17T06:30:00.000Z", "Asia/Shanghai", "zh-CN", now)).toBe("下一次：今天 14:30");
    expect(nextFireLabel("2026-10-18T06:30:00.000Z", "Asia/Shanghai", "zh-CN", now)).toBe("下一次：10-18 14:30");
    expect(nextFireLabel(null, "Asia/Shanghai", "zh-CN", now)).toBe("暂无下一次提醒");
    expect(periodicStateLabel({ state: "paused_today", nextFireAt: null, timezone: "UTC" }, "zh-CN")).toBe("今天暂停");
    expect(periodicStateLabel({ state: "scheduled", nextFireAt: "2026-10-17T06:30:00.000Z", timezone: "Asia/Shanghai" }, "zh-CN", now)).toBe("下一次：今天 14:30");
  });
});

describe("platform conventions", () => {
  it("detects the platform from the one place that looks", () => {
    expect(detectPlatform({ userAgentData: { platform: "macOS" } })).toBe("macos");
    expect(detectPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
    expect(detectPlatform({})).toBe("other");
  });
  it("uses ⌘ alone on macOS and Ctrl alone elsewhere", () => {
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, "macos")).toBe(true);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "macos")).toBe(false);
    expect(isPrimaryModifier({ metaKey: false, ctrlKey: true }, "windows")).toBe(true);
    expect(isPrimaryModifier({ metaKey: true, ctrlKey: false }, "windows")).toBe(false);
  });
  it("writes shortcuts the way each OS does", () => {
    const stored = "Super+Control+Alt+Shift+KeyK";
    expect(formatShortcut(stored, "macos")).toBe("⌃⌥⇧⌘K");
    expect(formatShortcut(stored, "windows")).toBe("Win+Ctrl+Alt+Shift+K");
    expect(formatShortcut("Control+Shift+Digit1", "windows")).toBe("Ctrl+Shift+1");
    expect(formatShortcut("Alt+Space", "macos")).toBe("⌥Space");
  });
  it("recognises text fields", () => {
    expect(isEditable({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isEditable({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isEditable({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isEditable(null)).toBe(false);
  });
});

describe("notification status", () => {
  const notifier = (authorization: string, available = true, detail: string | null = null) => ({ available, authorization: authorization as never, detail });
  it("maps authorised and provisional to granted", () => {
    expect(notificationStatus(notifier("authorized"), "macos", "zh-CN").state).toBe("granted");
    expect(notificationStatus(notifier("provisional"), "windows", "en").state).toBe("granted");
  });
  it("explains a denial per platform and offers the settings", () => {
    const mac = notificationStatus(notifier("denied"), "macos", "zh-CN");
    const win = notificationStatus(notifier("denied"), "windows", "zh-CN");
    expect(mac.state).toBe("denied");
    expect(mac.actions).toEqual({ request: false, openSettings: true, test: true });
    expect(win.reason).toMatch(/专注助手/);
    expect(mac.reason).not.toMatch(/专注助手/);
  });
  it("offers a request only when permission was never asked", () => {
    expect(notificationStatus(notifier("notDetermined"), "macos", "zh-CN").actions.request).toBe(true);
    expect(notificationStatus(notifier("unknown"), "windows", "zh-CN")).toMatchObject({ state: "unknown", actions: { request: false, openSettings: true } });
  });
  it("degrades when there is no helper or no report yet", () => {
    expect(notificationStatus(notifier("unknown", false, "no helper"), "other", "en")).toMatchObject({
      state: "unsupported",
      actions: { request: false, openSettings: true, test: true },
    });
    expect(notificationStatus(undefined, "windows", "en").state).toBe("unknown");
  });
  it("words the results of testing and requesting", () => {
    expect(testResultLabel({ ok: true, channel: "toast" }, "zh-CN")).toBe("已提交系统（toast）");
    expect(testResultLabel({ ok: false }, "en")).toBe("Could not send");
    expect(requestResultLabel({ authorization: "authorized", needsSystemSettings: false }, "macos", "zh-CN")).toBe("已授权");
    expect(requestResultLabel({ authorization: "denied", needsSystemSettings: true }, "windows", "zh-CN")).toMatch(/专注助手/);
  });
});

describe("task form for repeating tasks", () => {
  const base = newDraft(undefined, "2026-10-19", "每日站会");
  it("defaults a weekly repeat to the weekday of the planned date", () => {
    expect(isoWeekday("2026-10-19")).toBe(1);
    expect(isoWeekday("2026-10-18")).toBe(7);
    expect(base.weekdays).toEqual([1]);
  });
  it("sends a fixed time and a per-instance reminder only when switched on", () => {
    const off = draftPayload({ ...base, repeat: "daily" }) as Record<string, unknown>;
    expect(off.scheduledTime).toBeUndefined();
    expect(off.reminderTime).toBeUndefined();
    const on = draftPayload({ ...base, repeat: "weekly", weekdays: [3, 1], repeatTimeOn: true, repeatTime: "09:30", repeatReminderOn: true, repeatReminderTime: "09:20" }) as Record<string, unknown>;
    expect(on).toMatchObject({ repeat: { kind: "weekly", weekdays: [1, 3] }, startDate: "2026-10-19", scheduledTime: "09:30", reminderTime: "09:20" });
    expect(on.scheduledDate).toBeUndefined();
  });
  it("starts the repeat from the planned day", () => {
    expect(startRepeat({ ...base, scheduledMode: "date", scheduledDate: "2026-11-02" })).toEqual({ start: "2026-11-02" });
    expect(startRepeat({ ...base, scheduledMode: "none" })).toEqual({});
  });
  it("completes HH:mm inputs with seconds", () => {
    const payload = draftPayload({ ...base, scheduledMode: "time", scheduledDate: "2026-10-19", scheduledTime: "14:30", reminder: "2026-10-19T14:00" }) as Record<string, unknown>;
    expect(payload.scheduledAt).toBe("2026-10-19T14:30:00");
    expect(payload.reminderAt).toBe("2026-10-19T14:00:00");
  });
  it("says why a draft cannot be saved", () => {
    expect(validateDraft({ ...base, title: " " }, "zh-CN")).toBe("请输入标题");
    expect(validateDraft({ ...base, title: "x", estimate: "-5" }, "zh-CN")).toBe("预计耗时需要是非负整数分钟");
    expect(validateDraft({ ...base, title: "x", estimate: "1.5" }, "zh-CN")).toBe("预计耗时需要是非负整数分钟");
    expect(validateDraft({ ...base, title: "x", repeat: "weekly", weekdays: [] }, "zh-CN")).toBe("每周重复至少选择一天");
    expect(validateDraft({ ...base, title: "x", estimate: "25" }, "zh-CN")).toBeNull();
  });
});
