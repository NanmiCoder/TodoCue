import type { Task } from "@todocue/shared";
import type { MenuItem } from "./menuModel.js";

/** What a menu item does. The host (Panel) decides how: busy lock, refresh, confirmation. */
export interface TaskMenuCommands {
  complete(task: Task): void;
  snooze(task: Task): void;
  tomorrow(task: Task): void;
  edit(task: Task): void;
  cancel(task: Task): void;
  skip(task: Task): void;
  reopen(task: Task): void;
  /** Asks first: deleting is permanent. */
  requestDelete(task: Task): void;
}

/**
 * Commands that look the real implementation up when they run. A menu's items are built once, when
 * it opens, and a menu can stay open while the board refreshes; going through `current()` keeps
 * every command on the host's latest state (latest task version, latest busy flag) instead of the
 * render the menu happened to open in.
 */
export function delegateCommands(current: () => TaskMenuCommands): TaskMenuCommands {
  return {
    complete: (task) => current().complete(task),
    snooze: (task) => current().snooze(task),
    tomorrow: (task) => current().tomorrow(task),
    edit: (task) => current().edit(task),
    cancel: (task) => current().cancel(task),
    skip: (task) => current().skip(task),
    reopen: (task) => current().reopen(task),
    requestDelete: (task) => current().requestDelete(task),
  };
}

export interface TaskMenuContext {
  language: string;
  online: boolean;
  /** A write is already in flight; the items stay visible but disabled. */
  busy?: boolean;
  commands: TaskMenuCommands;
}

/** Wording follows the native client's catalog (`Translations.swift`). */
const labels = {
  complete: ["完成", "Done"],
  snooze: ["稍后提醒 10 分钟", "Snooze for 10 minutes"],
  tomorrow: ["改期到明天", "Move to tomorrow"],
  edit: ["编辑…", "Edit…"],
  cancel: ["取消", "Cancel"],
  skip: ["跳过本次", "Skip this occurrence"],
  reopen: ["重新打开", "Reopen"],
  delete: ["删除…", "Delete…"],
  saveAs: ["另存为…", "Save as…"],
} as const;
export type MenuLabel = keyof typeof labels;
export function menuLabel(key: MenuLabel, language: string) {
  return labels[key][language === "en" ? 1 : 0];
}

/**
 * The row menu, mirroring the native `TaskContextMenu`: an open task can be completed, snoozed,
 * moved to tomorrow, edited, cancelled (and, as a series instance, skipped); any other task can be
 * reopened or edited; every task can be deleted. All items are disabled while offline.
 */
export function taskMenuItems(task: Task, ctx: TaskMenuContext): MenuItem[] {
  const disabled = !ctx.online || !!ctx.busy;
  const at = (key: MenuLabel) => menuLabel(key, ctx.language);
  const { commands } = ctx;
  const item = (
    id: string,
    key: MenuLabel,
    icon: Extract<MenuItem, { kind: "item" }>["icon"],
    run: (task: Task) => void,
    danger = false,
  ): MenuItem => ({ kind: "item", id, label: at(key), icon, danger, disabled, onSelect: () => run(task) });
  const separator: MenuItem = { kind: "separator" };
  const remove = item("delete", "delete", "trash", commands.requestDelete, true);
  if (task.status === "todo") {
    return [
      item("complete", "complete", "check", commands.complete),
      item("snooze", "snooze", "snooze", commands.snooze),
      item("tomorrow", "tomorrow", "tomorrow", commands.tomorrow),
      item("edit", "edit", "edit", commands.edit),
      separator,
      item("cancel", "cancel", "close", commands.cancel, true),
      ...(task.seriesId ? [item("skip", "skip", "skip", commands.skip)] : []),
      separator,
      remove,
    ];
  }
  return [
    item("reopen", "reopen", "repeat", commands.reopen),
    item("edit", "edit", "edit", commands.edit),
    separator,
    remove,
  ];
}

/** The attachment menu (native: `.contextMenu { Button("另存为…") }`). */
export function attachmentMenuItems(ctx: { language: string; available: boolean; save: () => void }): MenuItem[] {
  return [{
    kind: "item",
    id: "save",
    label: menuLabel("saveAs", ctx.language),
    icon: "download",
    disabled: !ctx.available,
    onSelect: ctx.save,
  }];
}

/** The permanent-delete confirmation, shared by every place that can ask for it. */
export function deleteConfirmText(language: string) {
  const en = language === "en";
  return {
    title: en ? "Delete this task?" : "删除这个任务？",
    body: en
      ? "The task, reminders and attachments will be permanently removed."
      : "任务、提醒和附件会被永久删除。",
    confirm: en ? "Delete task" : "删除任务",
    cancel: en ? "Cancel" : "取消",
  };
}
