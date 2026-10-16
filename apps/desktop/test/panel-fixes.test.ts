import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@todocue/shared";
import { afterTaskDeleted, removeTolerantly } from "../src/deletion.js";
import { completedView } from "../src/completed.js";
import { failureOf } from "../src/errors.js";
import { returnFocusTarget } from "../src/menuModel.js";
import { isSubmitChord } from "../src/platform.js";
import { createShortcutHandler, shortcutFor, type ShortcutEvent, type ShortcutState } from "../src/shortcuts.js";
import { delegateCommands, taskMenuItems, type TaskMenuCommands } from "../src/taskMenu.js";
import { latestTask } from "../src/taskLookup.js";
import { initialToasts, showToast, type UndoAction } from "../src/toast.js";

const undo: UndoAction = { kind: "order", token: "tok" };
const withUndo = showToast(initialToasts, { message: "m", undo });
function state(patch: Partial<ShortcutState> = {}): ShortcutState {
  return {
    route: "list", menuOpen: false, pendingDelete: false, pendingMove: false, search: "",
    panelPinned: false, toast: withUndo, canWrite: true, ...patch,
  };
}
function key(patch: Partial<ShortcutEvent> & { key: string }): ShortcutEvent {
  return { metaKey: false, ctrlKey: false, shiftKey: false, defaultPrevented: false, target: null, preventDefault: vi.fn(), ...patch };
}
const notFound = Object.assign(new Error("gone"), { code: "NOT_FOUND" });
const conflict = Object.assign(new Error("changed"), { code: "VERSION_CONFLICT" });
function task(patch: Partial<Task> = {}): Task {
  return { id: "t1", title: "T", status: "todo", version: 1, timezone: "Asia/Shanghai", seriesId: null, ...patch } as Task;
}

describe("undo shortcut reads the panel as it is when the key is pressed", () => {
  it("a toast raised while saving can be undone once the save finished", () => {
    // The listener is installed while `run()` is still saving; the toast it raised is undone later.
    const current = { value: state({ canWrite: false }) };
    const perform = vi.fn();
    const handle = createShortcutHandler(() => current.value, perform, "macos");
    current.value = state({ canWrite: true });
    const event = key({ key: "z", metaKey: true });
    handle(event);
    expect(perform).toHaveBeenCalledWith({ kind: "undo", action: undo });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("keeps the toast when a write is still in flight", () => {
    const perform = vi.fn();
    const event = key({ key: "z", metaKey: true });
    createShortcutHandler(() => state({ canWrite: false }), perform, "macos")(event);
    expect(perform).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves the shortcut to a text field", () => {
    expect(shortcutFor({ ...key({ key: "z", metaKey: true }), target: { tagName: "INPUT" } as unknown as EventTarget }, state(), "macos")).toBeNull();
  });

  it("macOS takes only the command key and Windows only control", () => {
    expect(shortcutFor(key({ key: "z", ctrlKey: true }), state(), "macos")).toBeNull();
    expect(shortcutFor(key({ key: "z", metaKey: true }), state(), "windows")).toBeNull();
    expect(shortcutFor(key({ key: "z", ctrlKey: true }), state(), "windows")?.intent.kind).toBe("undo");
  });

  it("ignores a key an inner control already handled", () => {
    const perform = vi.fn();
    createShortcutHandler(() => state(), perform, "macos")(key({ key: "z", metaKey: true, defaultPrevented: true }));
    expect(perform).not.toHaveBeenCalled();
  });

  it("Esc and the close chord peel layers in order", () => {
    const esc = key({ key: "Escape" });
    const kinds = (patch: Partial<ShortcutState>) => shortcutFor(esc, state(patch), "macos")?.intent.kind ?? null;
    expect(kinds({ menuOpen: true, pendingDelete: true, route: "detail" })).toBe("closeMenu");
    expect(kinds({ pendingDelete: true, pendingMove: true, route: "detail" })).toBe("cancelDelete");
    expect(kinds({ pendingMove: true, route: "detail" })).toBe("cancelMove");
    expect(kinds({ route: "detail", search: "x" })).toBe("back");
    expect(kinds({ search: "x" })).toBe("clearSearch");
    expect(kinds({})).toBe("hide");
    expect(kinds({ panelPinned: true })).toBeNull();
    expect(shortcutFor(key({ key: "w", metaKey: true }), state({ route: "form" }), "macos")?.intent.kind).toBe("back");
  });
});

describe("deleting a task", () => {
  it("counts a task that is already gone as deleted", async () => {
    await expect(removeTolerantly(() => Promise.reject(notFound))).resolves.toBe("gone");
    await expect(removeTolerantly(() => Promise.resolve({}))).resolves.toBe("deleted");
  });

  it("still reports every other failure so the confirmation stays up", async () => {
    await expect(removeTolerantly(() => Promise.reject(conflict))).rejects.toBe(conflict);
    const offline = new Error("offline");
    await expect(removeTolerantly(() => Promise.reject(offline))).rejects.toBe(offline);
  });

  it("closes the edit form of the deleted task and falls back to what was before it", () => {
    const list = { route: "list" };
    const detail = { route: "detail", task: { id: "a" } };
    const result = afterTaskDeleted({ route: "form", taskId: "a" }, [list, detail], "a");
    expect(result.stack).toEqual([]);
    expect(result.leaveTo).toBe(list);
  });

  it("goes to the list when nothing is left, and leaves other pages alone", () => {
    expect(afterTaskDeleted({ route: "detail", taskId: "a" }, [], "a").leaveTo).toBeNull();
    const other = { route: "detail", task: { id: "b" } };
    const result = afterTaskDeleted({ route: "calendar" }, [other], "a");
    expect(result).toEqual({ stack: [other], leaveTo: undefined });
    expect(afterTaskDeleted({ route: "form", taskId: "b" }, [], "a").leaveTo).toBeUndefined();
  });
});

describe("menu commands write against the live task", () => {
  it("latestTask reads the board it is given", () => {
    const stale = task({ version: 1 });
    const board = { all: [task({ version: 4 })], today: { completed: [] as Task[] } };
    expect(latestTask(board, stale).version).toBe(4);
    expect(latestTask({ all: [], today: { completed: [task({ version: 7, status: "done" })] } }, stale).version).toBe(7);
    expect(latestTask(null, stale)).toBe(stale);
  });

  it("a menu built before a refresh runs the commands of the render after it", () => {
    const first = { complete: vi.fn() } as unknown as TaskMenuCommands;
    const second = { complete: vi.fn() } as unknown as TaskMenuCommands;
    let current = first;
    const items = taskMenuItems(task(), { language: "en", online: true, commands: delegateCommands(() => current) });
    current = second; // the board refreshed while the menu stayed open
    const done = items.find((item) => item.kind === "item" && item.id === "complete");
    if (done?.kind !== "item") throw new Error("missing item");
    done.onSelect();
    expect(first.complete).not.toHaveBeenCalled();
    expect(second.complete).toHaveBeenCalledOnce();
  });
});

describe("the save chord", () => {
  it("is Command+Enter on macOS and Control+Enter elsewhere", () => {
    const enter = { key: "Enter" };
    expect(isSubmitChord({ ...enter, metaKey: true, ctrlKey: false }, "macos")).toBe(true);
    expect(isSubmitChord({ ...enter, metaKey: false, ctrlKey: true }, "macos")).toBe(false);
    expect(isSubmitChord({ ...enter, metaKey: false, ctrlKey: true }, "windows")).toBe(true);
    expect(isSubmitChord({ ...enter, metaKey: true, ctrlKey: false }, "windows")).toBe(false);
    expect(isSubmitChord({ key: "a", metaKey: true, ctrlKey: false }, "macos")).toBe(false);
  });

  it("no panel source tests metaKey || ctrlKey itself", () => {
    // Only the global-shortcut recorder may accept either modifier: it records what the person pressed.
    const allowed = new Set(["SettingsPage.tsx", "platform.ts"]);
    const either = /metaKey\s*\|\|\s*[\w.]*ctrlKey|ctrlKey\s*\|\|\s*[\w.]*metaKey/;
    const dir = new URL("../src/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !allowed.has(name))
      .filter((name) => either.test(readFileSync(new URL(name, dir), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("completed history page", () => {
  it("does not claim to be loading after the connection dropped", () => {
    expect(completedView({ loaded: false, loading: true, online: true, count: 0 })).toBe("loading");
    expect(completedView({ loaded: false, loading: true, online: false, count: 0 })).toBe("offline");
    expect(completedView({ loaded: false, loading: false, online: true, count: 0 })).toBe("offline");
    expect(completedView({ loaded: true, loading: true, online: false, count: 3 })).toBe("list");
    expect(completedView({ loaded: true, loading: false, online: true, count: 0 })).toBe("empty");
  });
});

describe("a failed move", () => {
  it("asks for a reload when the task changed elsewhere", () => {
    expect(failureOf(conflict, "en")).toEqual({ message: "Changed elsewhere. Refreshed.", reload: true });
    expect(failureOf(notFound, "en").reload).toBe(false);
    expect(failureOf(new Error("boom"), "en")).toEqual({ message: "boom", reload: false });
  });
});

describe("focus after a dialog", () => {
  const el = (connected = true) => ({ isConnected: connected });
  it("prefers the element that had focus, then the row's own control", () => {
    const body = el(), row = el(), preferred = el();
    expect(returnFocusTarget(preferred, row, body)).toBe(preferred);
    expect(returnFocusTarget(body, row, body)).toBe(row);
    expect(returnFocusTarget(el(false), row, body)).toBe(row);
    expect(returnFocusTarget(null, null, body)).toBeNull();
    expect(returnFocusTarget(preferred, el(false), body)).toBe(preferred);
  });
});
