import type { IconName } from "./icons.js";

/** One row of a context menu. Pure data, so menus can be built and tested without a DOM. */
export type MenuItem =
  | { kind: "separator" }
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: IconName;
      danger?: boolean;
      /** Already formatted for the platform, e.g. `formatMenuShortcut(["mod", "N"])`. */
      shortcut?: string;
      disabled?: boolean;
      onSelect: () => void;
    };

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

export interface MenuPlacement {
  left: number;
  top: number;
  /** Set when the menu is taller than the viewport; the menu then scrolls. */
  maxHeight?: number;
  flippedX: boolean;
  flippedY: boolean;
}

/**
 * Place a menu of `size` at `anchor`, inside `viewport` (the WebView window, not the screen:
 * the panel and the notch are separate native windows, so their viewport is all there is).
 * It opens down-right of the pointer and flips to the other side of it when that edge would be
 * crossed, then clamps so a margin is always kept.
 */
export function placeMenu(anchor: Point, size: Size, viewport: Size, margin = 8): MenuPlacement {
  const room = (extent: number) => Math.max(0, extent - margin * 2);
  const height = Math.min(size.height, room(viewport.height));
  const maxHeight = size.height > room(viewport.height) ? room(viewport.height) : undefined;
  const flippedX = anchor.x + size.width + margin > viewport.width;
  const flippedY = anchor.y + height + margin > viewport.height;
  const clamp = (value: number, extent: number, viewportExtent: number) =>
    Math.min(Math.max(value, margin), Math.max(margin, viewportExtent - extent - margin));
  return {
    left: clamp(flippedX ? anchor.x - size.width : anchor.x, size.width, viewport.width),
    top: clamp(flippedY ? anchor.y - height : anchor.y, height, viewport.height),
    maxHeight,
    flippedX,
    flippedY,
  };
}

/** Index of the next enabled item from `from` in `direction`, wrapping; -1 if none is enabled. */
export function nextEnabled(items: MenuItem[], from: number, direction: 1 | -1): number {
  const count = items.length;
  for (let step = 1; step <= count; step++) {
    const index = (((from + direction * step) % count) + count) % count;
    const item = items[index]!;
    if (item.kind === "item" && !item.disabled) return index;
  }
  return -1;
}

export function edgeEnabled(items: MenuItem[], edge: "first" | "last"): number {
  return edge === "first" ? nextEnabled(items, -1, 1) : nextEnabled(items, items.length, -1);
}

/**
 * Whether a right-click should keep the system menu. Editing fields and selected text keep it
 * (cut/copy/paste, as the native client's Edit menu does); development builds keep it everywhere
 * so Inspect Element stays reachable. Everything else (Look Up, Translate, Reload, Print, Inspect
 * in a release build) is suppressed, on macOS and on Windows alike.
 */
export function keepsNativeMenu(input: { editable: boolean; hasSelection: boolean; development: boolean }) {
  return input.development || input.editable || input.hasSelection;
}

/**
 * Where focus goes back to when a menu or a dialog opened from it closes: the element that had it,
 * unless that is gone or is just the page body, in which case the row's own control.
 */
export function returnFocusTarget<T extends { isConnected: boolean }>(
  preferred: T | null | undefined,
  fallback: T | null | undefined,
  body: T | null | undefined,
): T | null {
  if (preferred && preferred.isConnected && preferred !== body) return preferred;
  return fallback && fallback.isConnected ? fallback : null;
}
