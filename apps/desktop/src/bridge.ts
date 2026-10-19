import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  TodoCueClient,
  type Request,
  type TransportResponse,
} from "@todocue/client";
import { RuntimeEvent, type RuntimeEvent as Event } from "@todocue/shared";
import { revealKind, type RevealMode } from "./model.js";

export interface ConnectionState {
  online: boolean;
  message?: string;
  generation?: string;
}
export interface DesktopSettings {
  language: "zh-CN" | "en";
  width: number;
  height: number;
  notchEnabled: boolean;
  notchDisplay: { id: string; name: string } | null;
  notchPlacement: "top" | "left" | "right";
  quietFullscreen: boolean;
  shortcut: string | null;
  autostart: boolean;
}
export const native = isTauri();
import { platform, type Platform } from "./platform.js";
/** The one place the host OS is read from the WebView lives in platform.ts. */
export { platform, type Platform };
export interface NotchMetrics { bandHeight: number; compactWidth: number; housingWidth: number }
export async function loadNotchMetrics(): Promise<NotchMetrics> {
  return native ? invoke<NotchMetrics>("notch_metrics") : { bandHeight: 32, compactWidth: 229, housingWidth: 185 };
}
export interface NotchDisplay {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
  hasNotch: boolean;
}
export async function loadNotchDisplays(): Promise<NotchDisplay[]> {
  return native ? invoke<NotchDisplay[]>("notch_displays") : [];
}
const initialLanguage = navigator.language.startsWith("zh") ? "zh-CN" : "en";
export const defaults: DesktopSettings = {
  language: initialLanguage,
  width: 340,
  height: 680,
  notchEnabled: true,
  notchDisplay: null,
  notchPlacement: "top",
  quietFullscreen: true,
  shortcut: null,
  autostart: false,
};

async function request(input: Request): Promise<TransportResponse> {
  if (native) return invoke("runtime_request", { input });
  const response = await fetch(`/__runtime/v1${input.path}`, {
    method: input.method,
    headers: {
      "Content-Type": "application/json",
      ...(input.idempotencyKey
        ? { "Idempotency-Key": input.idempotencyKey }
        : {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}
export const client = new TodoCueClient({ transport: { request } });

/** Install listeners before the host opens its stream; tokens never enter the WebView. */
export async function subscribe(
  onEvent: (event: Event) => void,
  onState: (state: ConnectionState) => void,
) {
  if (native) {
    const stopEvent = await listen<Event>("runtime:event", (event) =>
      onEvent(RuntimeEvent.parse(event.payload)),
    );
    const stopState = await listen<ConnectionState>("runtime:state", (event) =>
      onState(event.payload),
    );
    try {
      onState(await invoke<ConnectionState>("runtime_subscribe"));
    } catch (error) {
      stopEvent();
      stopState();
      throw error;
    }
    return () => {
      stopEvent();
      stopState();
    };
  }
  const source = new EventSource("/__runtime/v1/events");
  source.onopen = () => onState({ online: true });
  source.onerror = () =>
    onState({ online: false, message: "Runtime disconnected" });
  const types = RuntimeEvent.shape.type.options;
  for (const type of types)
    source.addEventListener(type, (event) => {
      const parsed = RuntimeEvent.safeParse(
        JSON.parse((event as MessageEvent).data),
      );
      if (parsed.success) onEvent(parsed.data);
    });
  return () => source.close();
}

export async function loadSettings(): Promise<DesktopSettings> {
  const saved = native
    ? await invoke<Partial<DesktopSettings>>("settings_load")
    : JSON.parse(localStorage.getItem("todocue:settings") ?? "{}");
  if (native && !saved) {
    await saveSettings(defaults);
    return defaults;
  }
  return {
    ...defaults,
    ...saved,
    language:
      saved?.language === "zh-CN" || saved?.language === "en"
        ? saved.language
        : defaults.language,
  };
}
let savingSettings: Promise<unknown> = Promise.resolve();
export function saveSettings(settings: DesktopSettings) {
  const operation = savingSettings
    .catch(() => {})
    .then(async () => {
      if (native) await invoke("settings_save", { settings });
      else localStorage.setItem("todocue:settings", JSON.stringify(settings));
    });
  savingSettings = operation;
  return operation;
}
export async function openPanel() {
  if (native) await invoke("panel_show");
}
export async function focusPanel() {
  if (native) await invoke("panel_focus");
}
export async function openTaskComposer() {
  if (native) await invoke("panel_new_task");
  else
    window.dispatchEvent(
      new CustomEvent("todocue:route", { detail: { kind: "new_task" } }),
    );
}
export async function hidePanel() {
  if (native) await invoke("panel_hide");
}
export async function startDrag() {
  if (native) await invoke("panel_drag");
}
export async function presentNotch(state: {
  width: number;
  height: number;
  pinned: boolean;
  expanded: boolean;
  stack: boolean;
  /** Take the keyboard (the input field or the notch band was clicked); card buttons never do. */
  focus?: boolean;
}) {
  if (native)
    return invoke<boolean>("notch_present", {
      state: {
        ...state,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      },
    });
  // The browser preview stands in for the native window: it takes the requested size too, so the
  // shell fills it the way it fills the real window (a menu growing the window is visible here).
  const root = document.getElementById("root")!;
  root.style.width = `${state.width}px`;
  root.style.height = `${state.height}px`;
  return true;
}
/**
 * The panel went from hidden to shown. The native host emits `panel:revealed`; callers keep a
 * visibility fallback for hosts that do not (see watchReveal in motionKit).
 */
export async function onPanelRevealed(handler: () => void): Promise<() => void> {
  if (!native) return () => undefined;
  // `replay: false` means a fade-out was cancelled, not that the panel arrived.
  return listen<{ replay?: boolean }>("panel:revealed", (event) => {
    if (event.payload?.replay !== false) handler();
  });
}
/**
 * Show a task in the panel. `mode` asks the panel to open its edit form, or to ask before
 * deleting it (the notch's "Edit…" and "Delete…" menu items need the panel, as in the original).
 */
export async function revealTask(id: string, mode?: RevealMode) {
  if (native) {
    await invoke("reveal_task", mode ? { id, mode } : { id });
  } else if (mode)
    window.dispatchEvent(new CustomEvent("todocue:route", { detail: { kind: revealKind(mode), id } }));
  else window.dispatchEvent(new CustomEvent("todocue:reveal", { detail: id }));
}

export async function canShowNotch() {
  return native ? invoke<boolean>("notch_available") : true;
}

export async function resizePanel(direction: "West" | "South") {
  if (native) await getCurrentWindow().startResizeDragging(direction);
}

export const manualPanelResize = native && platform === "macos";
export function resizePanelMac(input: {
  direction: "West" | "South";
  width: number;
  height: number;
  delta: number;
}) {
  return invoke<void>("panel_resize_macos", input);
}

// --- Cross-platform notification and data-folder abstractions -----------------------------
//
// Both work through the runtime's HTTP API, which already speaks to the macOS notifier helper and
// the Windows toast helper, so they need no host command. Opening the data folder does need one;
// the host provides `open_data_dir`; a host without it (or a browser) falls back to showing the path.
import {
  notificationStatus,
  requestResultLabel,
  testResultLabel,
  type NotificationStatus,
} from "./notification.js";

export type { NotificationStatus } from "./notification.js";

export async function loadNotificationStatus(language: string): Promise<NotificationStatus & { doctor: Awaited<ReturnType<typeof client.doctor>> }> {
  const doctor = await client.doctor();
  return { ...notificationStatus(doctor.notifier, platform, language), doctor };
}
export async function requestNotificationPermission(language: string): Promise<string> {
  return requestResultLabel(await client.requestNotificationAuthorization(), platform, language);
}
export async function openNotificationSettings(language: string): Promise<string> {
  const { ok } = await client.openNotificationSettings();
  if (ok) return language === "en" ? "Opened the system notification settings" : "已打开系统通知设置";
  return platform === "windows"
    ? language === "en" ? "Open Windows Settings › System › Notifications yourself" : "无法自动打开，请手动前往 Windows 设置 › 系统 › 通知"
    : language === "en" ? "Open System Settings › Notifications yourself" : "无法自动打开，请手动前往系统设置 › 通知";
}
export async function sendTestNotification(language: string): Promise<string> {
  return testResultLabel(await client.testNotification(), language);
}

const missingCommand = (error: unknown) => /not found|unknown command|not allowed/i.test(String(error));
/**
 * Open the data folder in the file manager. The host opens its own data directory; the renderer
 * names no path (`_path` is only what the page shows). `opened: false` means this host cannot
 * open folders (a browser, or a build without the command): show the path instead.
 */
export async function openDataFolder(_path?: string): Promise<{ opened: boolean }> {
  if (!native) return { opened: false };
  try {
    await invoke("open_data_dir");
    return { opened: true };
  } catch (error) {
    if (missingCommand(error)) return { opened: false };
    throw error;
  }
}
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
export interface TrayState {
  language: DesktopSettings["language"];
  remaining: number;
  online: boolean;
  nextTitle: string | null;
  nextId: string | null;
}
/** Quit the desktop app. The background runtime keeps running, so reminders are still delivered. */
export async function quitApp() {
  if (native) await invoke("app_quit");
}
/** Push what the menu-bar / tray entry shows; the host rebuilds its menu from this. */
export async function updateTray(state: TrayState) {
  if (native) await invoke("tray_update", { state });
}
/**
 * Save an export in the system Downloads folder and reveal it in the file manager.
 * Returns the written path. The browser preview falls back to a download link.
 */
export async function exportJson(name: string, contents: string): Promise<string> {
  if (native) return invoke<string>("export_json", { name, contents });
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/**
 * Save an attachment where the person chooses. The host fetches it from the runtime itself and
 * writes the file, so the bytes never cross the renderer. Resolves to the saved path, or null when
 * the dialog was cancelled. The browser preview downloads the bytes it already has.
 */
export async function saveAttachment(
  taskId: string | undefined,
  file: { id?: string; name: string; mediaType: string },
  browserData?: () => Promise<string>,
): Promise<string | null> {
  // A file that is not on the runtime yet (an unsaved draft's attachment) has no id to fetch by:
  // its bytes are already here, so it takes the download path on every host.
  const stored = taskId && file.id;
  if (native && stored) return invoke<string | null>("save_file", { taskId, attachmentId: file.id });
  const data = browserData
    ? await browserData()
    : stored
      ? (await client.getAttachment(taskId, file.id!)).dataBase64
      : "";
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return file.name;
}
