import type { AppleSyncChannel, AppleSyncKind, AppleSyncSnapshot, AppleSyncStatus } from "./bridge.js";

/**
 * Copy and state for the "Sync" settings tab, kept to the SwiftUI app's settings section
 * (`apps/macos/Sources/TodoCue/SettingsView.swift`, `AppleSyncSection`) word for word.
 */
type Language = "zh-CN" | "en";
const pick = (language: Language, zh: string, en: string) => (language === "en" ? en : zh);

export const appleSyncKinds: AppleSyncKind[] = ["event", "reminder"];

export function channelTitle(kind: AppleSyncKind, language: Language): string {
  return kind === "event" ? pick(language, "同步到日历", "Sync to Calendar") : pick(language, "同步到提醒事项", "Sync to Reminders");
}

export function explanation(language: Language): string {
  return pick(language,
    "有日期的待办会出现在 Apple 日历和提醒事项的「TodoCue」中，经 iCloud 同步到 iPhone。在那边修改、完成或删除，会写回 TodoCue（在那边删除条目，约 10 分钟后会同步删除对应任务）。仅在 TodoCue 运行时同步，不设闹钟。",
    "Dated tasks appear in a \"TodoCue\" calendar and reminder list, which iCloud carries to your iPhone. Edits, completions and deletions made there come back to TodoCue (deleting an item there deletes the task after about 10 minutes). Syncs only while TodoCue is running; no alerts are added.");
}

/** Both on shows every dated task twice in Calendar: once as an event, once as a reminder. */
export function recommendation(status: AppleSyncStatus, language: Language): { text: string; warning: boolean } {
  const both = status.event.enabled && status.reminder.enabled;
  return {
    warning: both,
    text: both
      ? pick(language, "两个都开着：同一任务会在日历里显示两次。建议只保留「同步到提醒事项」。", "Both are on, so each task shows up twice in Calendar. Keeping only Sync to Reminders is recommended.")
      : pick(language, "推荐只开「同步到提醒事项」：可直接勾选完成，带日期的提醒也会显示在日历里（iOS 18 / macOS 15 起）。", "Sync to Reminders alone is recommended: you can check tasks off, and dated reminders also show in Calendar (iOS 18 / macOS 15 and later)."),
  };
}

export function anyEnabled(status: AppleSyncStatus | null): boolean {
  return !!status && (status.event.enabled || status.reminder.enabled);
}

/** The line beside "Sync now", in the SwiftUI order: syncing, error, last sync, waiting. */
export function statusLine(status: AppleSyncStatus, language: Language, time: (instant: string) => string): { text: string; error: boolean } {
  if (status.syncing) return { text: pick(language, "正在同步…", "Syncing…"), error: false };
  if (status.lastError) return { text: pick(language, `同步出错：${status.lastError}`, `Sync error: ${status.lastError}`), error: true };
  // A switch carried over from another client (or a reinstall) can be on without access: no round runs.
  const on = appleSyncKinds.filter(kind => status[kind].enabled);
  if (on.length && on.every(kind => status[kind].access !== "granted")) {
    return { text: pick(language, "等待授权后同步", "Will sync once access is granted"), error: true };
  }
  if (status.lastSyncAt) return { text: pick(language, `上次同步 ${time(status.lastSyncAt)}`, `Last synced ${time(status.lastSyncAt)}`), error: false };
  return { text: pick(language, "等待连接运行时后同步", "Will sync once the runtime is connected"), error: false };
}

/** What sits under a switch. Access problems come first; the container only shows for a channel that is on. */
export type ChannelNotice =
  | { kind: "writeOnly"; text: string }
  | { kind: "needsAccess"; text: string }
  | { kind: "denied"; text: string }
  | { kind: "container"; text: string; warning: string | null }
  | null;

export function channelNotice(kind: AppleSyncKind, channel: AppleSyncChannel, language: Language): ChannelNotice {
  if (channel.access === "denied") return { kind: "denied", text: pick(language, "macOS 未允许访问", "macOS has not allowed access") };
  // On, but macOS has not granted full access to this app yet (the switch came from the SwiftUI app, or
  // only write access was given): flipping the switch is not the obvious way to ask, so offer it.
  if (channel.enabled && channel.access !== "granted") {
    return { kind: "needsAccess", text: pick(language, "开关已打开，但还没有获得完整访问权限，暂未同步。", "On, but TodoCue does not have full access yet, so nothing syncs.") };
  }
  if (channel.access === "writeOnly") {
    return { kind: "writeOnly", text: pick(language, "目前只有写入权限，打开开关可申请完整访问", "Write-only access so far. Turn the switch on to request full access.") };
  }
  const container = channel.enabled ? channel.container : null;
  if (!container) return null;
  return {
    kind: "container",
    text: pick(language, `「${container.title}」· ${container.sourceTitle}`, `"${container.title}" · ${container.sourceTitle}`),
    warning: container.isICloud ? null : kind === "event"
      ? pick(language, "这台 Mac 未开启 iCloud 日历，不会同步到 iPhone。可在系统设置 › Apple 账户 › iCloud 中开启「日历」。", "iCloud Calendars is off on this Mac, so this will not reach your iPhone. Turn on Calendars in System Settings › Apple Account › iCloud.")
      : pick(language, "这台 Mac 未开启 iCloud 提醒事项，不会同步到 iPhone。可在系统设置 › Apple 账户 › iCloud 中开启「提醒事项」。", "iCloud Reminders is off on this Mac, so this will not reach your iPhone. Turn on Reminders in System Settings › Apple Account › iCloud."),
  };
}

/** Nothing to operate yet: the copy shown in place of the switches. */
export function unavailableText(snapshot: AppleSyncSnapshot | null, language: Language): string | null {
  if (!snapshot) return pick(language, "正在读取同步状态…", "Reading sync status…");
  // The tab only shows on macOS, so a missing helper means a build without it (a dev build, the browser preview).
  if (!snapshot.available) return pick(language, "这个构建没有附带 Apple 同步程序。正式安装的 TodoCue 中可用。", "This build does not include Apple sync. It is available in the installed TodoCue app.");
  if (!snapshot.running || !snapshot.status) return pick(language, "同步服务正在启动…", "Starting sync…");
  return null;
}

/** The host's own refusals (`apple_sync.rs`) in the panel's language; anything else passes through. */
export function hostErrorText(message: string, language: Language): string {
  if (message.includes("not running")) return pick(language, "同步服务正在启动，请稍后再试。", "Sync is starting. Try again shortly.");
  if (message.includes("stopped unexpectedly")) return pick(language, "同步服务意外退出，正在重新启动。", "Sync stopped unexpectedly and is restarting.");
  if (message.includes("did not answer")) return pick(language, "同步服务没有响应，请稍后再试。", "Sync did not respond. Try again shortly.");
  if (message.includes("only available")) return pick(language, "这个构建没有附带 Apple 同步程序。", "This build does not include Apple sync.");
  return message;
}

export function removalText(language: Language) {
  return {
    title: pick(language, "移除 Apple 中的 TodoCue 数据？", "Remove TodoCue data from Apple's apps?"),
    body: pick(language, "将关闭同步，并删除 Apple 侧的「TodoCue」日历或列表。TodoCue 里的任务不受影响。", "Sync is turned off and the \"TodoCue\" calendar or list is deleted from Apple's apps. Your tasks in TodoCue are not affected."),
    confirm: pick(language, "移除", "Remove"),
    cancel: pick(language, "取消", "Cancel"),
  };
}
