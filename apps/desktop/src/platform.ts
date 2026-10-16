/**
 * Platform identity and the keyboard conventions that follow from it.
 *
 * The WebView exposes no host-provided platform flag yet, so the one lookup lives here and every
 * other module asks `platform` / `isPrimaryModifier` instead of sniffing on its own.
 */
export type Platform = "macos" | "windows" | "other";

interface PlatformSource {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

export function detectPlatform(source: PlatformSource | undefined = globalThis.navigator): Platform {
  const hint = `${source?.userAgentData?.platform ?? ""} ${source?.platform ?? ""} ${source?.userAgent ?? ""}`;
  if (/mac/i.test(hint)) return "macos";
  if (/windows|win32|win64|wow64/i.test(hint)) return "windows";
  return "other";
}

export const platform: Platform = detectPlatform();

interface ModifierEvent {
  metaKey: boolean;
  ctrlKey: boolean;
}

/**
 * macOS commands use ⌘ only: Ctrl+N/F/R in a text field mean "next line" / "forward" / etc. there.
 * Windows and Linux use Ctrl, and the Windows key is never a panel shortcut.
 */
export function isPrimaryModifier(event: ModifierEvent, on: Platform = platform): boolean {
  return on === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function primaryLabel(on: Platform = platform): string {
  return on === "macos" ? "⌘" : "Ctrl+";
}

/** "⌘↵" on macOS, "Ctrl+↵" elsewhere. */
export function chord(key: string, on: Platform = platform): string {
  return `${primaryLabel(on)}${key}`;
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Enter: "↵",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "⌫",
  Delete: "Del",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
};

/** Stored shortcuts look like "Super+Control+Shift+KeyK"; show them the way each OS writes them. */
export function formatShortcut(shortcut: string, on: Platform = platform): string {
  const parts = shortcut.split("+").filter(Boolean);
  const code = parts.pop() ?? "";
  const key = code.startsWith("Key")
    ? code.slice(3)
    : code.startsWith("Digit")
      ? code.slice(5)
      : (KEY_NAMES[code] ?? code);
  const held = new Set(parts);
  if (on === "macos") {
    return (
      (held.has("Control") ? "⌃" : "") +
      (held.has("Alt") ? "⌥" : "") +
      (held.has("Shift") ? "⇧" : "") +
      (held.has("Super") ? "⌘" : "") +
      key
    );
  }
  return [
    held.has("Super") ? "Win" : null,
    held.has("Control") ? "Ctrl" : null,
    held.has("Alt") ? "Alt" : null,
    held.has("Shift") ? "Shift" : null,
    key,
  ]
    .filter(Boolean)
    .join("+");
}

/** True while a key press belongs to a text field and must not be taken as a panel command. */
export function isEditable(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element?.tagName) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

export type MenuShortcutKey = "mod" | "ctrl" | "alt" | "shift" | (string & {});

/**
 * Context-menu hints from abstract keys. "mod" is Command on macOS and Control elsewhere.
 * macOS: ⌃⌥⇧⌘K. Elsewhere: Ctrl+Alt+Shift+K.
 */
export function formatMenuShortcut(keys: MenuShortcutKey[], on: Platform = platform): string {
  const names = (key: MenuShortcutKey) => {
    if (key === "mod") return on === "macos" ? "⌘" : "Ctrl";
    if (key === "ctrl") return on === "macos" ? "⌃" : "Ctrl";
    if (key === "alt") return on === "macos" ? "⌥" : "Alt";
    if (key === "shift") return on === "macos" ? "⇧" : "Shift";
    return key.length === 1 ? key.toUpperCase() : key;
  };
  if (on === "macos") {
    const order = ["ctrl", "alt", "shift", "mod"];
    const modifiers = order.filter((key) => keys.includes(key)).map(names);
    const rest = keys.filter((key) => !order.includes(key)).map(names);
    return [...modifiers, ...rest].join("");
  }
  const order = ["mod", "ctrl", "alt", "shift"];
  const modifiers = order.filter((key) => keys.includes(key)).map(names);
  const rest = keys.filter((key) => !order.includes(key)).map(names);
  return [...new Set([...modifiers, ...rest])].join("+");
}
