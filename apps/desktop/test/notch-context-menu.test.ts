import { describe, expect, it } from "vitest";
import {
  estimateMenuHeight,
  MENU_MARGIN,
  menuWindowHeight,
  pinDuringMenu,
  QUICK_LOOK_MAX_HEIGHT,
  revealKind,
} from "../src/model.js";
import { taskMenuItems, type TaskMenuCommands } from "../src/taskMenu.js";
import type { Task } from "@todocue/shared";

const task = (patch: Partial<Task> = {}) => ({ id: "t_1", title: "A", status: "todo", version: 1, ...patch }) as Task;
const commands: TaskMenuCommands = {
  complete: () => {}, snooze: () => {}, tomorrow: () => {}, edit: () => {},
  cancel: () => {}, skip: () => {}, reopen: () => {}, requestDelete: () => {},
};

describe("the notch window holds an open context menu", () => {
  it("estimates a menu from its items and separators", () => {
    const items = taskMenuItems(task(), { language: "zh-CN", online: true, commands });
    // 6 items + 2 separators + padding, matching .context-menu in style.css
    expect(items.filter((item) => item.kind === "item")).toHaveLength(6);
    expect(estimateMenuHeight(items)).toBe(14 + 6 * 32 + 2 * 11);
    expect(estimateMenuHeight([])).toBe(14);
  });
  it("leaves the window alone without a menu", () => {
    expect(menuWindowHeight({ content: 286, cap: 560 })).toBe(286);
    expect(menuWindowHeight({ content: 286, cap: 560, menu: null, extentBottom: null })).toBe(286);
  });
  it("grows the window to anchor + menu + margin, then to the reported extent", () => {
    const menu = { anchorY: 150, height: 228 };
    expect(menuWindowHeight({ content: 286, cap: 560, menu })).toBe(150 + 228 + MENU_MARGIN);
    expect(menuWindowHeight({ content: 286, cap: 560, menu, extentBottom: 400 })).toBe(400);
    expect(menuWindowHeight({ content: 286, cap: 560, extentBottom: 300 })).toBe(300);
  });
  it("never shrinks below the content and never exceeds the cap", () => {
    expect(menuWindowHeight({ content: 520, cap: 560, menu: { anchorY: 10, height: 100 } })).toBe(520);
    expect(menuWindowHeight({ content: 286, cap: QUICK_LOOK_MAX_HEIGHT, menu: { anchorY: 500, height: 300 } })).toBe(560);
    expect(menuWindowHeight({ content: 286, cap: 560, extentBottom: 900 })).toBe(560);
  });
  it("closing gives the height back to the content", () => {
    const open = menuWindowHeight({ content: 286, cap: 560, menu: { anchorY: 200, height: 300 }, extentBottom: 500 });
    const closed = menuWindowHeight({ content: 286, cap: 560, menu: null, extentBottom: null });
    expect(open).toBeGreaterThan(closed);
    expect(closed).toBe(286);
  });
});

describe("pinning around a menu", () => {
  it("pins while open and restores the earlier state when closed", () => {
    expect(pinDuringMenu(false, true)).toBe(true);
    expect(pinDuringMenu(true, true)).toBe(true);
    expect(pinDuringMenu(false, false)).toBe(false);
    expect(pinDuringMenu(true, false)).toBe(true);
  });
});

describe("the notch menu mirrors the panel's items", () => {
  const ids = (items: ReturnType<typeof taskMenuItems>) =>
    items.filter((item) => item.kind === "item").map((item) => (item.kind === "item" ? item.id : ""));
  it("offers every task command for an open task, skip only for a series instance", () => {
    expect(ids(taskMenuItems(task(), { language: "en", online: true, commands }))).toEqual(
      ["complete", "snooze", "tomorrow", "edit", "cancel", "delete"],
    );
    expect(ids(taskMenuItems(task({ seriesId: "s_1" }), { language: "en", online: true, commands }))).toContain("skip");
    expect(ids(taskMenuItems(task({ status: "done" }), { language: "en", online: true, commands }))).toEqual(
      ["reopen", "edit", "delete"],
    );
  });
  it("greys everything out while offline or busy", () => {
    for (const ctx of [{ online: false }, { online: true, busy: true }]) {
      const items = taskMenuItems(task(), { language: "zh-CN", commands, ...ctx });
      expect(items.filter((item) => item.kind === "item").every((item) => item.kind === "item" && item.disabled)).toBe(true);
    }
  });
  it("routes edit and delete to the panel through reveal modes", () => {
    const calls: string[] = [];
    const items = taskMenuItems(task(), {
      language: "zh-CN", online: true,
      commands: { ...commands, edit: (t) => calls.push(`edit:${t.id}`), requestDelete: (t) => calls.push(`delete:${t.id}`) },
    });
    for (const item of items) if (item.kind === "item" && (item.id === "edit" || item.id === "delete")) item.onSelect();
    expect(calls).toEqual(["edit:t_1", "delete:t_1"]);
    expect(revealKind()).toBe("task");
    expect(revealKind("edit")).toBe("task_edit");
    expect(revealKind("delete")).toBe("task_delete");
  });
});
