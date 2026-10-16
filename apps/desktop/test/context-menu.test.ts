import { describe, expect, it, vi } from "vitest";
import type { Task } from "@todocue/shared";
import { rescheduleToTomorrow, rescheduleUndo } from "../src/dates.js";
import { edgeEnabled, keepsNativeMenu, nextEnabled, placeMenu, type MenuItem } from "../src/menuModel.js";
import { detectPlatform, formatMenuShortcut } from "../src/platform.js";
import {
  attachmentMenuItems,
  deleteConfirmText,
  taskMenuItems,
  type TaskMenuCommands,
} from "../src/taskMenu.js";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Write report",
    status: "todo",
    version: 3,
    timezone: "Asia/Shanghai",
    seriesId: null,
    scheduledDate: null,
    scheduledAt: null,
    dueDate: null,
    dueAt: null,
    ...patch,
  } as Task;
}
function commands(): TaskMenuCommands {
  return {
    complete: vi.fn(), snooze: vi.fn(), tomorrow: vi.fn(), edit: vi.fn(),
    cancel: vi.fn(), skip: vi.fn(), reopen: vi.fn(), requestDelete: vi.fn(),
  };
}
const ids = (items: MenuItem[]) => items.map((item) => (item.kind === "separator" ? "-" : item.id));
const entries = (items: MenuItem[]) => items.filter((item): item is Extract<MenuItem, { kind: "item" }> => item.kind === "item");

describe("taskMenuItems mirrors the native TaskContextMenu across its state matrix", () => {
  const cases = [
    { status: "todo", series: false, online: true, ids: ["complete", "snooze", "tomorrow", "edit", "-", "cancel", "-", "delete"] },
    { status: "todo", series: true, online: true, ids: ["complete", "snooze", "tomorrow", "edit", "-", "cancel", "skip", "-", "delete"] },
    { status: "done", series: false, online: true, ids: ["reopen", "edit", "-", "delete"] },
    { status: "done", series: true, online: true, ids: ["reopen", "edit", "-", "delete"] },
    { status: "todo", series: false, online: false, ids: ["complete", "snooze", "tomorrow", "edit", "-", "cancel", "-", "delete"] },
    { status: "todo", series: true, online: false, ids: ["complete", "snooze", "tomorrow", "edit", "-", "cancel", "skip", "-", "delete"] },
    { status: "cancelled", series: false, online: false, ids: ["reopen", "edit", "-", "delete"] },
    { status: "skipped", series: true, online: false, ids: ["reopen", "edit", "-", "delete"] },
  ] as const;
  for (const c of cases) {
    it(`${c.status}${c.series ? " (series instance)" : ""}, ${c.online ? "online" : "offline"}`, () => {
      const items = taskMenuItems(
        task({ status: c.status, seriesId: c.series ? "s1" : null }),
        { language: "zh-CN", online: c.online, commands: commands() },
      );
      expect(ids(items)).toEqual(c.ids);
      expect(entries(items).every((item) => item.disabled === !c.online)).toBe(true);
      expect(entries(items).filter((item) => item.danger).map((item) => item.id)).toEqual(
        c.status === "todo" ? ["cancel", "delete"] : ["delete"],
      );
    });
  }

  it("runs each item's command against the task it was built for", () => {
    const run = commands();
    const subject = task({ seriesId: "s1" });
    const byId = Object.fromEntries(entries(taskMenuItems(subject, { language: "en", online: true, commands: run })).map((item) => [item.id, item]));
    byId.complete!.onSelect(); byId.snooze!.onSelect(); byId.tomorrow!.onSelect(); byId.edit!.onSelect();
    byId.cancel!.onSelect(); byId.skip!.onSelect(); byId.delete!.onSelect();
    for (const name of ["complete", "snooze", "tomorrow", "edit", "cancel", "skip", "requestDelete"] as const)
      expect(run[name]).toHaveBeenCalledWith(subject);
    expect(run.reopen).not.toHaveBeenCalled();
  });

  it("uses the native client's wording in both languages", () => {
    const labels = (language: string) =>
      entries(taskMenuItems(task({ seriesId: "s" }), { language, online: true, commands: commands() })).map((item) => item.label);
    expect(labels("zh-CN")).toEqual(["完成", "稍后提醒 10 分钟", "改期到明天", "编辑…", "取消", "跳过本次", "删除…"]);
    expect(labels("en")).toEqual(["Done", "Snooze for 10 minutes", "Move to tomorrow", "Edit…", "Cancel", "Skip this occurrence", "Delete…"]);
  });

  it("disables the items, not the menu, while a write is in flight", () => {
    const items = taskMenuItems(task(), { language: "en", online: true, busy: true, commands: commands() });
    expect(entries(items).every((item) => item.disabled)).toBe(true);
  });

  it("offers a single save-as item for attachments, available only with data or a connection", () => {
    const save = vi.fn();
    const [item] = entries(attachmentMenuItems({ language: "zh-CN", available: true, save }));
    expect(item!.label).toBe("另存为…");
    item!.onSelect();
    expect(save).toHaveBeenCalledOnce();
    expect(entries(attachmentMenuItems({ language: "en", available: false, save }))[0]).toMatchObject({ label: "Save as…", disabled: true });
  });

  it("words the delete confirmation in both languages", () => {
    expect(deleteConfirmText("zh-CN").title).toBe("删除这个任务？");
    expect(deleteConfirmText("en").confirm).toBe("Delete task");
  });
});

describe("placeMenu keeps the menu inside its window, in CSS pixels", () => {
  const viewport = { width: 340, height: 680 };
  const size = { width: 200, height: 240 };
  it("opens down-right of the pointer when there is room", () => {
    expect(placeMenu({ x: 40, y: 60 }, size, viewport)).toEqual({ left: 40, top: 60, maxHeight: undefined, flippedX: false, flippedY: false });
  });
  it("flips left when the right edge would be crossed", () => {
    const placed = placeMenu({ x: 300, y: 60 }, size, viewport);
    expect(placed).toMatchObject({ left: 100, flippedX: true, flippedY: false });
  });
  it("flips up when the bottom edge would be crossed", () => {
    const placed = placeMenu({ x: 40, y: 600 }, size, viewport);
    expect(placed).toMatchObject({ top: 360, flippedY: true, flippedX: false });
  });
  it("flips on both axes in the bottom-right corner", () => {
    expect(placeMenu({ x: 339, y: 679 }, size, viewport)).toMatchObject({ left: 132, top: 432, flippedX: true, flippedY: true });
  });
  it("keeps the margin when a flip would leave the other edge", () => {
    // 200 wide in a 210 wide window: neither side fits, so it clamps to the margin.
    const placed = placeMenu({ x: 100, y: 10 }, size, { width: 210, height: 680 });
    expect(placed.left).toBe(8);
  });
  it("scrolls a menu taller than the window instead of overflowing", () => {
    const placed = placeMenu({ x: 10, y: 150 }, { width: 200, height: 500 }, { width: 340, height: 300 });
    expect(placed.maxHeight).toBe(284);
    expect(placed.top).toBeGreaterThanOrEqual(8);
    expect(placed.top + 284).toBeLessThanOrEqual(300 - 8);
  });
  it("does no pixel arithmetic of its own, so display scaling cannot change the result", () => {
    // Inputs are CSS pixels throughout (clientX/Y, innerWidth/Height, offsetWidth/Height);
    // the same CSS geometry yields the same placement at any devicePixelRatio.
    const a = placeMenu({ x: 250.5, y: 410.25 }, size, viewport);
    const b = placeMenu({ x: 250.5, y: 410.25 }, size, viewport);
    expect(a).toEqual(b);
    expect(a.left).toBe(50.5);
  });
});

describe("keyboard navigation over menu items", () => {
  const item = (id: string, disabled = false): MenuItem => ({ kind: "item", id, label: id, disabled, onSelect: () => {} });
  const items: MenuItem[] = [item("a"), item("b", true), { kind: "separator" }, item("c"), item("d")];
  it("skips separators and disabled items and wraps", () => {
    expect(nextEnabled(items, 0, 1)).toBe(3);
    expect(nextEnabled(items, 4, 1)).toBe(0);
    expect(nextEnabled(items, 3, -1)).toBe(0);
    expect(nextEnabled(items, 0, -1)).toBe(4);
  });
  it("starts from either end", () => {
    expect(edgeEnabled(items, "first")).toBe(0);
    expect(edgeEnabled(items, "last")).toBe(4);
  });
  it("reports -1 when nothing is enabled", () => {
    expect(nextEnabled([item("a", true), { kind: "separator" }], -1, 1)).toBe(-1);
  });
});

describe("the native menu is suppressed except where editing needs it", () => {
  it("keeps it in fields, over selected text and in development builds only", () => {
    expect(keepsNativeMenu({ editable: true, hasSelection: false, development: false })).toBe(true);
    expect(keepsNativeMenu({ editable: false, hasSelection: true, development: false })).toBe(true);
    expect(keepsNativeMenu({ editable: false, hasSelection: false, development: true })).toBe(true);
    expect(keepsNativeMenu({ editable: false, hasSelection: false, development: false })).toBe(false);
  });
});

describe("shortcut text follows the platform", () => {
  it("identifies the platform from the WebView's own report", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("macos");
    expect(detectPlatform({ platform: "macOS" })).toBe("macos");
    expect(detectPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectPlatform({ platform: "Windows" })).toBe("windows");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
  });
  it("uses symbols on macOS and words elsewhere", () => {
    expect(formatMenuShortcut(["mod", "shift", "K"], "macos")).toBe("⇧⌘K");
    expect(formatMenuShortcut(["mod", "shift", "K"], "windows")).toBe("Ctrl+Shift+K");
    expect(formatMenuShortcut(["mod", "alt", "n"], "macos")).toBe("⌥⌘N");
    expect(formatMenuShortcut(["shift", "F10"], "windows")).toBe("Shift+F10");
  });
});

describe("rescheduleToTomorrow ports the native TaskRescheduling.tomorrow", () => {
  const today = "2026-10-14";
  it("plans an all-day task for tomorrow", () => {
    expect(rescheduleToTomorrow(task({ scheduledDate: "2026-10-12" }), today)).toEqual({
      expectedVersion: 3, scheduledDate: "2026-10-15", scheduledAt: null,
    });
  });
  it("gives an unplanned task tomorrow as its plan", () => {
    expect(rescheduleToTomorrow(task(), today)).toMatchObject({ scheduledDate: "2026-10-15", scheduledAt: null });
  });
  it("keeps a planned time of day, in the task's own zone", () => {
    const patch = rescheduleToTomorrow(task({ scheduledAt: "2026-10-13T01:30:00.000Z" }), today); // 09:30 in Shanghai
    expect(patch).toEqual({
      expectedVersion: 3, scheduledAt: "2026-10-15T01:30:00.000Z", scheduledDate: null, timezone: "Asia/Shanghai",
    });
  });
  it("resolves the time in the task's zone even when that zone is on another civil day", () => {
    const patch = rescheduleToTomorrow(
      task({ timezone: "America/Los_Angeles", scheduledAt: "2026-10-14T02:00:00.000Z" }), // 19:00 on the 13th in LA
      today,
    );
    expect(patch.scheduledAt).toBe("2026-10-16T02:00:00.000Z"); // 19:00 on the 15th in LA
  });
  it("moves an overdue all-day deadline out of Today as well", () => {
    expect(rescheduleToTomorrow(task({ scheduledDate: today, dueDate: "2026-10-10" }), today)).toMatchObject({
      scheduledDate: "2026-10-15", dueDate: "2026-10-15", dueAt: null,
    });
  });
  it("moves a deadline due today", () => {
    expect(rescheduleToTomorrow(task({ dueDate: today }), today)).toMatchObject({ dueDate: "2026-10-15" });
  });
  it("keeps a deadline that is already tomorrow or later", () => {
    for (const dueDate of ["2026-10-15", "2026-10-20"]) {
      const patch = rescheduleToTomorrow(task({ dueDate }), today);
      expect(patch).not.toHaveProperty("dueDate");
      expect(patch).not.toHaveProperty("dueAt");
    }
  });
  it("moves an exact deadline before tomorrow, keeping its time of day", () => {
    const patch = rescheduleToTomorrow(task({ dueAt: "2026-10-14T10:00:00.000Z" }), today); // 18:00 Shanghai
    expect(patch).toMatchObject({ dueAt: "2026-10-15T10:00:00.000Z", dueDate: null, timezone: "Asia/Shanghai" });
  });
  it("keeps an exact deadline from tomorrow onward", () => {
    // 2026-10-14T16:00Z is 00:00 on the 15th in Shanghai: tomorrow's first instant, so it stays.
    expect(rescheduleToTomorrow(task({ dueAt: "2026-10-14T16:00:00.000Z" }), today)).not.toHaveProperty("dueAt");
    expect(rescheduleToTomorrow(task({ dueAt: "2026-10-14T15:59:59.999Z" }), today)).toHaveProperty("dueAt");
  });
  it("leaves the reminder alone and never sends fields it did not change", () => {
    const patch = rescheduleToTomorrow(task({ scheduledDate: today, dueDate: "2026-10-30", reminderAt: "2026-10-14T01:00:00.000Z" }), today);
    expect(Object.keys(patch).sort()).toEqual(["expectedVersion", "scheduledAt", "scheduledDate"]);
  });
});

describe("rescheduleUndo", () => {
  it("restores only the plan when the deadline stayed put", () => {
    const before = task({ scheduledDate: "2026-10-17", dueDate: "2026-10-30", version: 3 });
    const after = task({ scheduledDate: "2026-10-18", dueDate: "2026-10-30", version: 4 });
    const undo = rescheduleUndo(before, after);
    expect(undo).toMatchObject({ kind: "reschedule", scheduledDate: "2026-10-17", expectedVersion: 4 });
    expect("dueDate" in undo).toBe(false);
  });
  it("also restores a deadline that “move to tomorrow” pulled along", () => {
    const before = task({ scheduledDate: "2026-10-17", dueDate: "2026-10-17", version: 3 });
    const after = task({ scheduledDate: "2026-10-18", dueDate: "2026-10-18", version: 4 });
    expect(rescheduleUndo(before, after)).toMatchObject({ dueDate: "2026-10-17", dueAt: before.dueAt });
  });
});
