/**
 * Panel feedback as a small state machine. One toast is visible at a time and a newer one replaces
 * it, so every toast carries an id and the timer that dismisses it only ever dismisses its own id.
 */
export type UndoAction =
  | { kind: "reopen"; taskId: string; version: number }
  | { kind: "order"; token: string }
  | {
      kind: "reschedule";
      taskId: string;
      scheduledDate: string | null;
      scheduledAt: string | null;
      timezone: string;
      /** Only set when the move also pulled a deadline out of the way (“move to tomorrow”). */
      dueDate?: string | null;
      dueAt?: string | null;
      /** The version the reschedule produced, so a later edit conflicts instead of being reverted. */
      expectedVersion: number;
    };

export type ToastKind = "info" | "error";

export interface NotifyInput {
  message: string;
  kind?: ToastKind;
  undo?: UndoAction;
}

export interface Toast extends NotifyInput {
  id: number;
  kind: ToastKind;
}

export interface ToastState {
  current: Toast | null;
  next: number;
}

export const initialToasts: ToastState = { current: null, next: 1 };

/** Messages disappear after 5s; ones that offer an undo stay for 10s. */
export const TOAST_MS = 5000;
export const UNDO_TOAST_MS = 10000;

export function toastDuration(toast: Pick<Toast, "undo">): number {
  return toast.undo ? UNDO_TOAST_MS : TOAST_MS;
}

export function showToast(state: ToastState, input: NotifyInput): ToastState {
  return { current: { ...input, kind: input.kind ?? "info", id: state.next }, next: state.next + 1 };
}

/** Dismiss by id; a stale timer for a toast that was already replaced does nothing. */
export function dismissToast(state: ToastState, id?: number): ToastState {
  if (!state.current || (id !== undefined && state.current.id !== id)) return state;
  return { ...state, current: null };
}

export function dismissErrors(state: ToastState): ToastState {
  return state.current?.kind === "error" ? { ...state, current: null } : state;
}

/** ⌘Z / Ctrl+Z runs the visible undo, unless the person is editing text where it belongs to the field. */
export function undoForShortcut(state: ToastState, editing: boolean): UndoAction | null {
  if (editing) return null;
  return state.current?.undo ?? null;
}

/** What the toast says after a drag landed. `targetLabel` is the dated name of the target group. */
export function moveMessage(
  move: { view: string; sourceGroup: string; targetGroup: string },
  language: string,
  targetLabel: string,
): string {
  const en = language === "en";
  if (move.sourceGroup === move.targetGroup) return en ? "Order updated" : "已调整执行顺序";
  if (move.view === "all") {
    const name = move.targetGroup || (en ? "No project" : "未分组");
    return en ? `Moved to “${name}”` : `已移至「${name}」`;
  }
  return en ? `Moved to ${targetLabel}; deadline and reminder unchanged` : `已改期至 ${targetLabel}，截止与提醒保持原值`;
}
