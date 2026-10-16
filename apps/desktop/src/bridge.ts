import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  TodoCueClient,
  type Request,
  type TransportResponse,
} from "@todocue/client";
import { RuntimeEvent, type RuntimeEvent as Event } from "@todocue/shared";

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
  quietFullscreen: boolean;
  shortcut: string | null;
  autostart: boolean;
}
export const native = isTauri();
export type Platform = "macos" | "windows" | "other";
/** The one place the host OS is read from the WebView; everything else imports this. */
export const platform: Platform = (() => {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return agent.includes("Macintosh") ? "macos" : agent.includes("Windows") ? "windows" : "other";
})();
/** The platform's command modifier: ⌘ on macOS only, Ctrl elsewhere. */
export function isCommandKey(event: { metaKey: boolean; ctrlKey: boolean }) {
  return platform === "macos" ? event.metaKey : event.ctrlKey;
}
export interface NotchMetrics { bandHeight: number }
export async function loadNotchMetrics(): Promise<NotchMetrics> {
  return native ? invoke<NotchMetrics>("notch_metrics") : { bandHeight: 24 };
}
const initialLanguage = navigator.language.startsWith("zh") ? "zh-CN" : "en";
export const defaults: DesktopSettings = {
  language: initialLanguage,
  width: 340,
  height: 680,
  notchEnabled: true,
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
  document.getElementById("root")!.style.width = `${state.width}px`;
  return true;
}
export async function revealTask(id: string) {
  if (native) {
    await invoke("reveal_task", { id });
  } else
    window.dispatchEvent(new CustomEvent("todocue:reveal", { detail: id }));
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

export interface TrayState {
  language: DesktopSettings["language"];
  remaining: number;
  online: boolean;
  nextTitle: string | null;
  nextId: string | null;
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
