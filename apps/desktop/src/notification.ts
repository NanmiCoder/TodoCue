import type { DoctorReport } from "@todocue/shared";
import type { Platform } from "./platform.js";

/**
 * One notification story for every host. macOS reports an authorization decision from the
 * notification centre; Windows reports whether the app's toasts are enabled (they can be off
 * in Settings or held back by Focus Assist). Anything else degrades to "unknown".
 */
export type NotificationState = "granted" | "denied" | "unknown" | "unsupported";

export interface NotificationStatus {
  state: NotificationState;
  /** Raw value from the notifier, for diagnostics. */
  raw: string;
  /** One sentence the settings page can show next to the state. */
  reason: string;
  /** Actions that make sense right now. */
  actions: { request: boolean; openSettings: boolean; test: boolean };
}

type Notifier = Pick<DoctorReport["notifier"], "available" | "authorization" | "detail">;

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
      return {
        state: "granted",
        raw: notifier.authorization,
        reason: notifier.authorization === "provisional" ? text("临时授权，通知会静默送达", "Provisional: notifications arrive quietly") : text("已授权", "Allowed"),
        actions: { request: false, openSettings: false, test: true },
      };
    case "denied":
      return {
        state: "denied",
        raw: "denied",
        reason:
          platform === "windows"
            ? text("通知已被关闭，或被专注助手 / 勿扰拦下。请在 Windows 设置 › 系统 › 通知 中开启 TodoCue。", "Notifications are off, or held back by Focus Assist. Turn TodoCue on in Windows Settings › System › Notifications.")
            : text("系统只询问一次，请在系统设置 › 通知中手动开启 TodoCue 的通知程序。", "The system asks only once. Turn the TodoCue notifier on in System Settings › Notifications."),
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
  return language === "en" ? `Handed to the system (${result.channel ?? "?"})` : `已提交系统（${result.channel ?? "?"}）`;
}

/** Result sentence after asking for permission. */
export function requestResultLabel(result: { authorization: string; needsSystemSettings: boolean }, platform: Platform, language: string): string {
  const en = language === "en";
  if (result.authorization === "authorized" || result.authorization === "provisional") return en ? "Allowed" : "已授权";
  if (result.needsSystemSettings || result.authorization === "denied")
    return notificationStatus({ available: true, authorization: "denied", detail: null }, platform, language).reason;
  return (en ? "Permission: " : "授权：") + result.authorization;
}
