import { isEditable, isPrimaryModifier, platform as hostPlatform, type Platform } from "./platform.js";
import { undoForShortcut, type ToastState, type UndoAction } from "./toast.js";

/** The panel's window-level keyboard commands, as pure data so they can be tested without a DOM. */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  preventDefault(): void;
}

export interface ShortcutState {
  route: string;
  menuOpen: boolean;
  pendingDelete: boolean;
  pendingMove: boolean;
  search: string;
  panelPinned: boolean;
  toast: ToastState;
  /** Online and not already saving: an undo that cannot run must not consume the toast. */
  canWrite: boolean;
}

export type ShortcutIntent =
  | { kind: "closeMenu" }
  | { kind: "cancelDelete" }
  | { kind: "cancelMove" }
  | { kind: "back" }
  | { kind: "clearSearch" }
  | { kind: "hide" }
  | { kind: "toggleCalendar" }
  | { kind: "undo"; action: UndoAction }
  | { kind: "newTask" }
  | { kind: "focusSearch" }
  | { kind: "refresh" }
  | { kind: "settings" };

export interface ShortcutResult {
  intent: ShortcutIntent;
  preventDefault: boolean;
}

/**
 * Esc and ⌘W peel one layer at a time: header menu, delete confirmation, move confirmation, a
 * sub-page, the search text, and finally the panel itself (unless it is pinned).
 */
function dismissal(state: ShortcutState): ShortcutIntent | null {
  if (state.menuOpen) return { kind: "closeMenu" };
  if (state.pendingDelete) return { kind: "cancelDelete" };
  if (state.pendingMove) return { kind: "cancelMove" };
  if (state.route !== "list") return { kind: "back" };
  if (state.search) return { kind: "clearSearch" };
  if (!state.panelPinned) return { kind: "hide" };
  return null;
}

export function shortcutFor(
  event: Omit<ShortcutEvent, "preventDefault">,
  state: ShortcutState,
  on: Platform = hostPlatform,
): ShortcutResult | null {
  const primary = isPrimaryModifier(event, on);
  const key = event.key.toLowerCase();
  if (event.key === "Escape" || (primary && !event.shiftKey && key === "w")) {
    const intent = dismissal(state);
    return intent ? { intent, preventDefault: event.key !== "Escape" } : null;
  }
  if (!primary) return null;
  if (event.shiftKey && key === "k") return { intent: { kind: "toggleCalendar" }, preventDefault: true };
  if (!event.shiftKey && key === "z") {
    // A visible undo wins; inside a text field the shortcut stays the field's own undo.
    const action = state.canWrite ? undoForShortcut(state.toast, isEditable(event.target ?? null)) : null;
    return action ? { intent: { kind: "undo", action }, preventDefault: true } : null;
  }
  if (key === "n") return { intent: { kind: "newTask" }, preventDefault: true };
  if (key === "f") return { intent: { kind: "focusSearch" }, preventDefault: true };
  if (key === "r") return { intent: { kind: "refresh" }, preventDefault: true };
  if (event.key === ",") return { intent: { kind: "settings" }, preventDefault: true };
  if (event.key === "[") return { intent: { kind: "back" }, preventDefault: true };
  return null;
}

/**
 * A handler to register once. `read` is consulted for every key press, so what it sees is the
 * panel as it is now, not as it was when the listener was installed.
 */
export function createShortcutHandler(
  read: () => ShortcutState,
  perform: (intent: ShortcutIntent) => void,
  on: Platform = hostPlatform,
) {
  return (event: ShortcutEvent) => {
    if (event.defaultPrevented) return;
    const result = shortcutFor(event, read(), on);
    if (!result) return;
    if (result.preventDefault) event.preventDefault();
    perform(result.intent);
  };
}
