import type { DoctorReport, RuntimeEvent } from "@todocue/shared";
import { invisibleReason } from "./notification.js";
import type { Platform } from "./platform.js";

/**
 * The panel's standing notification strip, as pure functions. Nothing here touches React, the
 * network or storage, so each branch can be tested without a window.
 */

export type BannerKind = "notDetermined" | "denied" | "unregistered" | "invisible" | "delivery" | "degraded";
export type BannerActionType = "request" | "openSettings" | "retry";

export interface NotificationBanner {
  kind: BannerKind;
  /** error: reminders are certainly not reaching the person. warn: they may not be. */
  severity: "warn" | "error";
  /** One line. */
  message: string;
  /** Longer technical text (the last error), for a tooltip. */
  detail?: string;
  /** The one primary button, or null when there is nothing the person can press. */
  action: { type: BannerActionType; label: string } | null;
}

export interface BannerOptions {
  platform: Platform;
  language: string;
  /**
   * Failed reminders the person already tried to re-send without anything being queued (the runtime
   * only re-sends the last 24 hours). The failed part of the strip stays quiet until the count grows.
   */
  acknowledgedFailed?: number;
  /** Overrides `doctor.reminders.failed`, for callers that counted the failed list themselves. */
  failedCount?: number;
}

const unhealthy = (level: string | undefined) => level === "error" || level === "warn";

export function notificationBanner(doctor: DoctorReport | null | undefined, options: BannerOptions): NotificationBanner | null {
  if (!doctor) return null;
  const { platform, language } = options;
  const en = language === "en";
  const text = (zh: string, english: string) => (en ? english : zh);
  const notifier = doctor.notifier;
  const mac = platform !== "windows";

  if (notifier.authorization === "denied") {
    return {
      kind: "denied",
      severity: "error",
      message: mac
        ? text("通知已被关闭，提醒不会弹出。", "Notifications are off, so reminders won’t appear.")
        : text("通知已被关闭，或被专注助手拦下，提醒不会弹出。", "Notifications are off or held back by Focus Assist, so reminders won’t appear."),
      action: { type: "openSettings", label: text("打开系统设置", "Open settings") },
    };
  }
  if (notifier.authorization === "notDetermined" && notifier.available) {
    return {
      kind: "notDetermined",
      severity: "error",
      message: text("TodoCue 还没有通知权限，提醒不会弹出。", "TodoCue isn’t allowed to send notifications yet, so reminders won’t appear."),
      action: { type: "request", label: text("允许通知", "Allow") },
    };
  }
  if (notifier.registered === false) {
    return {
      kind: "unregistered",
      severity: "error",
      message: invisibleReason({ registered: false, alertStyle: notifier.alertStyle }, platform, language),
      action: null,
    };
  }
  if (notifier.visible === false && (notifier.authorization === "authorized" || notifier.authorization === "provisional")) {
    return {
      kind: "invisible",
      severity: "error",
      message: invisibleReason({ registered: notifier.registered, alertStyle: notifier.alertStyle }, platform, language),
      action: { type: "openSettings", label: text("打开系统设置", "Open settings") },
    };
  }

  const reminders = doctor.reminders;
  const failedAll = Math.max(0, options.failedCount ?? reminders?.failed ?? 0);
  const failed = failedAll > (options.acknowledgedFailed ?? 0) ? failedAll : 0;
  const retrying = Math.max(0, reminders?.retrying ?? 0);
  const overdue = Math.max(0, reminders?.overduePending ?? 0);
  const check = doctor.checks.find((item) => item.name === "reminderDelivery");
  const checkBad = unhealthy(check?.level);
  if (failed > 0 || retrying > 0 || checkBad) {
    const parts: string[] = [];
    if (failed > 0) parts.push(text(`${failed} 条提醒没能送达`, `${failed} reminder${failed === 1 ? "" : "s"} failed to deliver`));
    if (retrying > 0) parts.push(text(`${retrying} 条正在重试`, `${retrying} retrying`));
    if (parts.length === 0) {
      if (overdue > 0) parts.push(text(`${overdue} 条提醒已到点但还没发出`, `${overdue} reminder${overdue === 1 ? " is" : "s are"} due but not sent yet`));
      else if (check?.level === "error") parts.push(text("提醒服务似乎停住了，提醒可能无法送达", "The reminder service looks stuck, so reminders may not arrive"));
      else parts.push(text("提醒的送达有些延迟", "Reminder delivery is running late"));
    }
    return {
      kind: "delivery",
      severity: failed > 0 || check?.level === "error" ? "error" : "warn",
      message: parts.join(text("，", ", ")) + (en ? "." : "。"),
      detail: reminders?.lastError?.message ?? check?.detail,
      action: failed > 0 || retrying > 0 ? { type: "retry", label: text("重新发送", "Re-send") } : null,
    };
  }
  if (notifier.degraded) {
    return {
      kind: "degraded",
      severity: "warn",
      message: text(
        "TodoCue 的通知组件缺失，提醒走备用通道，可能显示为“脚本编辑器”、无法点击跳转。请重新安装 TodoCue。",
        "TodoCue’s notification component is missing, so reminders use a fallback: they may show as “Script Editor” and can’t be clicked through. Reinstall TodoCue.",
      ),
      action: null,
    };
  }
  return null;
}

/** Toast after "重新发送". */
export function retryResultLabel(requeued: number, language: string): string {
  const en = language === "en";
  if (requeued <= 0) return en ? "No recent failed reminders to re-send" : "最近 24 小时内没有可重新发送的提醒";
  return en ? `Re-sending ${requeued} reminder${requeued === 1 ? "" : "s"}` : `已重新发送 ${requeued} 条提醒`;
}

// --- Asking for permission once ------------------------------------------------------------------

/**
 * A fresh install reports notDetermined and silently swallows reminders until somebody asks. The
 * panel asks once, on its own, per device and data directory. macOS never prompts a second time, so
 * repeating would only add noise; after a refusal the strip's "打开系统设置" is the way forward.
 */
export function shouldAutoRequest(
  doctor: DoctorReport | null | undefined,
  state: { alreadyRequested: boolean; sessionRequested: boolean },
): boolean {
  if (!doctor || state.alreadyRequested || state.sessionRequested) return false;
  return doctor.notifier.authorization === "notDetermined" && doctor.notifier.available;
}

export const AUTO_REQUEST_PREFIX = "todocue:notification-auto-requested:";

interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): FlagStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Has this data directory already been asked? A broken store answers no (the session flag still limits it to once). */
export function autoRequestRecorded(home: string, storage: FlagStorage | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(AUTO_REQUEST_PREFIX + home) === "1";
  } catch {
    return false;
  }
}

export function recordAutoRequest(home: string, storage: FlagStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(AUTO_REQUEST_PREFIX + home, "1");
  } catch {
    /* Private mode or a full store: the in-memory flag covers this session. */
  }
}

/** Events after which delivery health may have changed. */
export function isReminderEvent(event: Pick<RuntimeEvent, "type">): boolean {
  return event.type === "reminder.updated" || event.type === "reminder.fired";
}
