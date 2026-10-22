import type { DoctorReport, Reminder } from "@todocue/shared";
import type { Platform } from "./platform.js";

/**
 * One notification story for every host. macOS reports an authorization decision from the
 * notification centre; Windows reports whether the app's toasts are enabled (they can be off
 * in Settings or held back by Focus Assist). Anything else degrades to "unknown".
 */
export type NotificationState = "granted" | "invisible" | "denied" | "unknown" | "unsupported";

export interface NotificationStatus {
  state: NotificationState;
  /** Raw value from the notifier, for diagnostics. */
  raw: string;
  /** One sentence the settings page can show next to the state. */
  reason: string;
  /** Actions that make sense right now. */
  actions: { request: boolean; openSettings: boolean; test: boolean };
}

type Notifier = Pick<DoctorReport["notifier"], "available" | "authorization" | "detail"> &
  Partial<Pick<DoctorReport["notifier"], "alertStyle" | "visible" | "degraded" | "registered">>;

const alertStyleNames: Record<string, [string, string]> = { banner: ["横幅", "Banners"], alert: ["提醒", "Alerts"] };

function allowedReason(notifier: Pick<Notifier, "alertStyle">, language: string): string {
  const en = language === "en";
  const style = notifier.alertStyle ? alertStyleNames[notifier.alertStyle]?.[en ? 1 : 0] : undefined;
  if (!style) return en ? "Allowed" : "已授权";
  return en ? `Allowed. Style: ${style}` : `已授权，通知样式：${style}`;
}

/** Why an allowed notifier still shows nothing, in the words of the system's own settings. */
export function invisibleReason(notifier: Pick<Notifier, "alertStyle" | "registered">, platform: Platform, language: string): string {
  const en = language === "en";
  if (notifier.registered === false)
    return en
      ? "Windows has no registration for TodoCue's notifications, so reminders may be dropped silently. Reinstall TodoCue."
      : "Windows 里没有登记 TodoCue 的通知身份，提醒可能被系统悄悄丢弃。请重新安装 TodoCue。";
  if (platform === "windows")
    return en
      ? "Allowed, but TodoCue's notifications are off in Windows Settings › System › Notifications, so reminders will not appear."
      : "已授权，但 Windows 设置 › 系统 › 通知里 TodoCue 的通知被关了，提醒不会显示。";
  if (notifier.alertStyle === "none")
    return en
      ? "Allowed, but the alert style is “None”, so reminders will not appear. Choose Banners or Alerts in System Settings › Notifications › TodoCue."
      : "已授权，但通知样式为“无”，提醒不会显示。请在系统设置 › 通知 › TodoCue 里改成横幅或提醒。";
  return en
    ? "Allowed, but the system will not show TodoCue's notifications. Check System Settings › Notifications › TodoCue."
    : "已授权，但系统不会显示 TodoCue 的通知。请检查系统设置 › 通知 › TodoCue。";
}

export function notificationStatus(notifier: Notifier | undefined, platform: Platform, language: string): NotificationStatus {
  const en = language === "en";
  const text = (zh: string, english: string) => (en ? english : zh);
  if (!notifier) {
    return {
      state: "unknown",
      raw: "unknown",
      reason: text("还没有读到状态，点击“重新诊断”获取", "Not read yet. Run diagnostics to check."),
      actions: { request: false, openSettings: true, test: false },
    };
  }
  if (!notifier.available) {
    return {
      state: "unsupported",
      raw: notifier.authorization,
      // The runtime's own `detail` is English diagnostics text; it stays in the diagnostics list.
      reason: text("没有找到专用的通知程序，通知可能无法点击跳转，甚至不会送达。可以发测试通知确认。", "No dedicated notification helper was found. Notifications may not be clickable or may not arrive. Send a test to check."),
      actions: { request: false, openSettings: true, test: true },
    };
  }
  switch (notifier.authorization) {
    case "authorized":
    case "provisional":
      // Allowed is not the same as shown: with alert style "none" (macOS) or app notifications
      // switched off (Windows) the system accepts a reminder and displays nothing.
      if (notifier.visible === false) {
        return {
          state: "invisible",
          raw: notifier.authorization,
          reason: invisibleReason(notifier, platform, language),
          actions: { request: false, openSettings: true, test: true },
        };
      }
      return {
        state: "granted",
        raw: notifier.authorization,
        reason: notifier.authorization === "provisional" ? text("临时授权，通知会静默送达", "Provisional: notifications arrive quietly") : allowedReason(notifier, language),
        actions: { request: false, openSettings: false, test: true },
      };
    case "denied":
      return {
        state: "denied",
        raw: "denied",
        reason:
          platform === "windows"
            ? text("通知已被关闭，或被专注助手 / 勿扰拦下。请在 Windows 设置 › 系统 › 通知 中开启 TodoCue。", "Notifications are off, or held back by Focus Assist. Turn TodoCue on in Windows Settings › System › Notifications.")
            : text("系统只询问一次，请在系统设置 › 通知中手动开启 TodoCue。", "The system asks only once. Turn TodoCue on in System Settings › Notifications."),
        actions: { request: false, openSettings: true, test: true },
      };
    case "notDetermined":
      return {
        state: "unknown",
        raw: "notDetermined",
        reason: text("尚未请求授权", "Permission has not been requested yet"),
        actions: { request: true, openSettings: true, test: true },
      };
    default:
      return {
        state: "unknown",
        raw: notifier.authorization,
        reason: notifier.detail ?? text("系统没有返回通知状态，可以发送一条测试通知确认", "The system did not report a state. Send a test notification to check."),
        actions: { request: false, openSettings: true, test: true },
      };
  }
}

/** Result sentence after "测试通知". */
export function testResultLabel(result: { ok: boolean; channel?: string | null }, language: string): string {
  if (!result.ok) return language === "en" ? "Could not send" : "发送失败";
  // "Submitted" is all the runtime can know: whether the system then shows it depends on Focus and the alert style.
  return language === "en"
    ? `Handed to the system (${result.channel ?? "?"}). If you don't see it, check Focus mode and the notification style.`
    : `已提交给系统（${result.channel ?? "?"}），没看到的话请检查专注模式和通知样式`;
}

/** Result sentence after asking for permission. */
export function requestResultLabel(result: { authorization: string; needsSystemSettings: boolean; requeued?: number }, platform: Platform, language: string): string {
  const en = language === "en";
  if (result.authorization === "authorized" || result.authorization === "provisional") {
    const again = result.requeued ?? 0;
    if (again > 0) return en ? `Allowed. Re-sending ${again} missed reminder${again === 1 ? "" : "s"}` : `已授权，正在重新发送 ${again} 条没送达的提醒`;
    return en ? "Allowed" : "已授权";
  }
  if (result.needsSystemSettings || result.authorization === "denied")
    return notificationStatus({ available: true, authorization: "denied", detail: null }, platform, language).reason;
  return (en ? "Permission: " : "授权：") + result.authorization;
}

/** What to tell the person when the system settings could not be opened for them. */
export function openSettingsFailureLabel(platform: Platform, language: string): string {
  const en = language === "en";
  return platform === "windows"
    ? en ? "Open Windows Settings › System › Notifications yourself" : "无法自动打开，请手动前往 Windows 设置 › 系统 › 通知"
    : en ? "Open System Settings › Notifications yourself" : "无法自动打开，请手动前往系统设置 › 通知";
}

/** The newest few failed reminders, newest first, for the "recent failures" list. */
export function recentFailed(reminders: readonly Reminder[], limit = 5): Reminder[] {
  return reminders
    .filter((reminder) => reminder.status === "failed")
    .sort((a, b) => b.fireAt.localeCompare(a.fireAt))
    .slice(0, limit);
}
