/**
 * The desktop shell has no host command that reports the OS, so the platform is read once, here,
 * from the WebView's own report. Nothing else should look at the user agent.
 */
export type Platform = "mac" | "windows" | "other";

export function detectPlatform(info: { platform?: string; userAgent?: string }): Platform {
  const text = `${info.platform ?? ""} ${info.userAgent ?? ""}`;
  if (/Mac/i.test(text)) return "mac";
  if (/Win/i.test(text)) return "windows";
  return "other";
}

export const platform: Platform =
  typeof navigator === "undefined"
    ? "other"
    : detectPlatform({
        platform:
          (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
          navigator.platform,
        userAgent: navigator.userAgent,
      });

export type ShortcutKey = "mod" | "ctrl" | "alt" | "shift" | (string & {});

/** "mod" is Command on macOS and Control elsewhere. macOS: ⌃⌥⇧⌘K. Elsewhere: Ctrl+Alt+Shift+K. */
export function formatShortcut(keys: ShortcutKey[], on: Platform = platform): string {
  const names = (key: ShortcutKey) => {
    if (key === "mod") return on === "mac" ? "⌘" : "Ctrl";
    if (key === "ctrl") return on === "mac" ? "⌃" : "Ctrl";
    if (key === "alt") return on === "mac" ? "⌥" : "Alt";
    if (key === "shift") return on === "mac" ? "⇧" : "Shift";
    return key.length === 1 ? key.toUpperCase() : key;
  };
  if (on === "mac") {
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
