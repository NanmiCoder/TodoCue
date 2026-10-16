import { TodoCueClient, type Board } from "@todocue/client";
import type { PeriodicReminder, RuntimeEvent, Task } from "@todocue/shared";
import { describeError, isVersionConflict } from "./errors.js";

export interface Cue {
  key: string;
  id: string;
  title: string;
  repeats: number;
  receivedAt: number;
  task?: Task;
  periodic?: PeriodicReminder;
  dormant?: boolean;
  /** The runtime fired this reminder after its time had passed (reminder.fired `late`). */
  late?: boolean;
  /** How many tasks the runtime folded into this firing (reminder.fired `count`). */
  count?: number;
}
export function visibleCues(cues: Cue[], featuredKey: string | null) {
  return cues.filter((cue, index) => index < 3 || cue.key === featuredKey);
}

/** Pure state logic, shared by both windows and exercised with the real runtime. */
export class CueStack {
  entries: Cue[] = [];
  private seen = new Map<string, number>();
  private reservations = new Set<string>();
  receive(cue: Omit<Cue, "repeats">, now = Date.now()): boolean {
    for (const [id, at] of this.seen)
      if (now - at >= 300000) this.seen.delete(id);
    const current = this.entries.find((item) => item.key === cue.key);
    if (current?.id === cue.id) {
      Object.assign(current, cue);
      return false;
    }
    if (this.seen.has(cue.id)) return false;
    if (!current && this.entries.length >= 20) return false;
    this.seen.set(cue.id, now);
    if (current) Object.assign(current, cue, { repeats: current.repeats + 1 });
    else this.entries.push({ ...cue, repeats: 1 });
    return true;
  }
  sync(tasks: Task[], rules: PeriodicReminder[]) {
    this.entries = this.entries.filter((cue) => {
      if (cue.task) {
        const task = tasks.find((task) => task.id === cue.task!.id);
        if (
          !task ||
          task.status !== "todo" ||
          task.reminderAt !== cue.task.reminderAt
        )
          return false;
        cue.task = task;
        cue.title = task.title;
      }
      if (cue.periodic) {
        const rule = rules.find((rule) => rule.id === cue.periodic!.id);
        if (
          !rule ||
          !rule.enabled ||
          rule.state.startsWith("paused") ||
          rule.currentOccurrence?.result !== "pending" ||
          !["offered", "claimed", "displayed", "submitted"].includes(
            rule.currentOccurrence.delivery,
          )
        )
          return false;
        cue.periodic = rule;
        cue.title = rule.title;
        cue.dormant = !periodicActive(rule);
      }
      return true;
    });
  }
  shown() {
    return this.entries
      .filter((cue) => !cue.dormant)
      .sort((a, b) =>
        Number(this.reservations.has(b.key)) - Number(this.reservations.has(a.key)) ||
        Number(!!b.task) - Number(!!a.task),
      );
  }
  canDisplay(key: string) {
    const rows = this.shown();
    const index = rows.findIndex((cue) => cue.key === key);
    const reserved = [...this.reservations].filter((key) => !rows.some((row) => row.key === key));
    return index >= 0 ? index + reserved.length < 3 : rows.length + reserved.length < 3;
  }
  /** Reserve before any await, so simultaneous offers cannot claim the same slot. */
  reserve(key: string) {
    if (this.reservations.has(key) || !this.canDisplay(key)) return false;
    this.reservations.add(key);
    return true;
  }
  release(key: string) {
    this.reservations.delete(key);
  }
}

/** All history refresh paths share one epoch, including mutation-triggered reloads. */
export class LatestRequest {
  private epoch = 0;
  invalidate() { this.epoch++; }
  async run<T>(load: () => Promise<T>, apply: (value: T) => void, fail: (error: unknown) => void) {
    const epoch = ++this.epoch;
    try {
      const value = await load();
      if (epoch === this.epoch) apply(value);
    } catch (error) {
      if (epoch === this.epoch) fail(error);
    }
  }
}
export function shouldCollapseQuickLook(reason: "outside" | "leave", state: { expanded: boolean; pinned: boolean; editing: boolean }) {
  return state.expanded && (reason === "outside" || (!state.pinned && !state.editing));
}

export function periodicActive(rule: PeriodicReminder, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: rule.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      value("weekday"),
    ) + 1;
  const time = `${value("hour")}:${value("minute")}`;
  return (
    rule.weekdays.includes(weekday) &&
    rule.windows.some((window) => time >= window.start && time < window.end)
  );
}

export function taskCue(
  event: RuntimeEvent,
  task: Task,
  now = Date.now(),
): Omit<Cue, "repeats"> | null {
  const age = now - Date.parse(event.at);
  if (
    event.type !== "reminder.fired" ||
    !event.id ||
    event.related?.taskId !== task.id ||
    task.status !== "todo" ||
    event.related.fireAt !== task.reminderAt ||
    age < -5000 ||
    age >= 120000
  )
    return null;
  return {
    key: `task:${task.id}`,
    id: event.id,
    title: task.title,
    receivedAt: now,
    task,
    late: event.related?.late === "true",
    count: Math.max(1, Number(event.related?.count ?? "1") || 1),
  };
}

/** Board revisions exclude stale HTTP snapshots arriving after newer mutations. */
export function latestBoard(current: Board | null, incoming: Board): Board {
  return current && current.ordering.revision > incoming.ordering.revision
    ? current
    : incoming;
}
export async function completeAfterFeedback(
  client: TodoCueClient,
  task: Task,
  feedback: () => Promise<void>,
) {
  await feedback();
  return client.completeTask(task.id, { expectedVersion: task.version });
}

/** A hover-deferred row and a cue hidden by quick-look must never acknowledge display. */
export function canPresentPeriodic({
  enabled,
  expanded,
  hovered,
  foreground,
}: {
  enabled: boolean;
  expanded: boolean;
  hovered: boolean;
  foreground: boolean;
}) {
  return enabled && !expanded && !hovered && foreground;
}

/** Rows resting in the stack; the rest fold into "N more". Same as ReminderCue.swift `visibleRows`. */
export const STACK_VISIBLE_ROWS = 3;
/** Stack height cap (NotchController.sizeStack maxHeight 360) and the quick look cap. */
export const STACK_MAX_HEIGHT = 360;
export const QUICK_LOOK_MAX_HEIGHT = 560;
/** After the quick look folds, the stack comes back once the shell has shrunk (scheduleStackLayout). */
export const STACK_RETURN_DELAY = 350;
/** The collapsed badge breathes once in a while so a folded stack does not become wallpaper. */
export const PULSE_INTERVAL = 300000;

/**
 * Whether a new reminder must wait for the pointer to leave. Only a pointer resting on the stack
 * defers (a click aimed at one row must not land on another); the quick look takes arrivals live.
 */
export function shouldDeferArrival(state: {
  stackShown: boolean;
  pointerOnStack: boolean;
  alreadyListed: boolean;
}) {
  return state.stackShown && state.pointerOnStack && !state.alreadyListed;
}

/**
 * While the pointer rests on the stack, rows may leave or update but none may join: joining waits
 * for the pointer (`shouldDeferArrival`). Order of `next` is kept, rows unseen so far are dropped.
 */
export function freezeJoins(current: Cue[], next: Cue[]): Cue[] {
  const listed = new Set(current.map((cue) => cue.key));
  return next.filter((cue) => listed.has(cue.key));
}

export type QuickLookClose = "escape" | "panel-opened" | "outside" | "leave" | "fold-button" | "space-changed";
/**
 * Closing the quick look returns to the reminder stack; only the explicit fold button puts the stack
 * into the wings (NotchController.collapse vs collapseStack).
 */
export function foldsStack(reason: QuickLookClose) {
  return reason === "fold-button";
}

/** A panel-open request only touches the notch when its quick look is open. */
export function shouldCollapseForPanel(state: { expanded: boolean }) {
  return state.expanded;
}

/** CueMotion.ripple: progress of one ring over its 1.1 s life, 0 outside it (seconds). */
export function rippleProgress(time: number, reduced: boolean): number {
  if (reduced || !(time > 0) || time >= 1.1) return 0;
  const p = time / 1.1;
  return 1 - Math.pow(1 - p, 3);
}

export interface CuePose {
  scaleX: number;
  scaleY: number;
  offsetY: number;
  rotation: number;
}
const REST_POSE: CuePose = { scaleX: 1, scaleY: 1, offsetY: 0, rotation: 0 };
const POSE_KEYS: Array<[number, CuePose]> = [
  [0, REST_POSE],
  [0.12, { scaleX: 1.12, scaleY: 0.88, offsetY: 2, rotation: -5 }],
  [0.34, { scaleX: 0.94, scaleY: 1.06, offsetY: -7, rotation: 8 }],
  [0.54, { scaleX: 1.06, scaleY: 0.94, offsetY: 1, rotation: -3 }],
  [0.9, REST_POSE],
];
/** CueMotion.pose: preparation, little hop, soft landing, settle. Confined to the Cue mark. */
export function cuePose(time: number, reduced: boolean): CuePose {
  if (reduced || !(time >= 0) || time >= 0.9) return REST_POSE;
  for (let i = 1; i < POSE_KEYS.length; i++) {
    const [t1, b] = POSE_KEYS[i]!;
    if (time > t1) continue;
    const [t0, a] = POSE_KEYS[i - 1]!;
    const p = (time - t0) / (t1 - t0);
    const eased = p * p * (3 - 2 * p);
    const mix = (x: number, y: number) => x + (y - x) * eased;
    return {
      scaleX: mix(a.scaleX, b.scaleX),
      scaleY: mix(a.scaleY, b.scaleY),
      offsetY: mix(a.offsetY, b.offsetY),
      rotation: mix(a.rotation, b.rotation),
    };
  }
  return REST_POSE;
}

/** NotchLayout.countdown: relative label for the next task's planned time or deadline. */
export function taskCountdown(
  task: Pick<Task, "scheduledAt" | "dueAt">,
  now: number,
  language: string,
): { text: string; late: boolean } | null {
  const isDeadline = !task.scheduledAt;
  const iso = task.scheduledAt ?? task.dueAt;
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const delta = (at - now) / 1000;
  const late = delta < 0;
  const minutes = Math.floor(Math.abs(delta) / 60);
  const en = language === "en";
  let span = "";
  if (minutes >= 1 && minutes < 60) span = en ? `${minutes} min` : `${minutes} 分钟`;
  else if (minutes >= 60 && minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    span = m === 0 ? (en ? `${h} hr` : `${h} 小时`) : en ? `${h} hr ${m} min` : `${h} 小时 ${m} 分`;
  } else if (minutes >= 24 * 60) {
    const d = Math.floor(minutes / (24 * 60));
    span = en ? `${d} d` : `${d} 天`;
  }
  const none = span === "";
  const words = en
    ? {
        soon: ["Now", "In ", "Just started", "Elapsed: "],
        due: ["Due now", "Due in ", "Just due", "Overdue by "],
      }
    : {
        soon: ["就是现在", "还有 ", "刚到时间", "已过 "],
        due: ["马上截止", "距截止 ", "刚刚截止", "已逾期 "],
      };
  const [exact, ahead, justPast, past] = isDeadline ? words.due : words.soon;
  const text = !late ? (none ? exact! : ahead! + span) : none ? justPast! : past! + span;
  return { text, late };
}

/** CueText.meta: what kind of reminder a row is and how long it has waited. */
export function cueMeta(cue: Cue, now: number, language: string): string {
  const en = language === "en";
  if (cue.periodic) {
    const rule = cue.periodic;
    const every = en ? `Every ${rule.intervalMinutes} minutes` : `每 ${rule.intervalMinutes} 分钟`;
    const due = rule.currentOccurrence?.result === "pending" ? Date.parse(rule.currentOccurrence.fireAt) : NaN;
    const waited = Number.isFinite(due) ? Math.max(0, Math.floor((now - due) / 60000)) : 0;
    if (waited <= 0) return `${every} · ${en ? "Just now" : "刚刚"}`;
    return `${every} · ${en ? `Waiting ${waited} min` : `已等 ${waited} 分钟`}`;
  }
  const more = (cue.count ?? 1) - 1;
  if (more > 0) return en ? `${more} more waiting. Take a look.` : `还有 ${more} 件事等你，点开看看。`;
  const kind = en ? "Task reminder" : "任务提醒";
  if (cue.task) {
    const countdown = taskCountdown(cue.task, now, language);
    if (countdown) return `${kind} · ${countdown.text}`;
    if (cue.task.project) return cue.task.project;
  }
  return kind;
}

/** Context menu inside the notch window. Sizes mirror `.context-menu` in style.css. */
const MENU_ITEM_HEIGHT = 32;
const MENU_SEPARATOR_HEIGHT = 11;
const MENU_PADDING = 14;
export const MENU_MARGIN = 8;

/** Height a menu will need, from its items, before it has been laid out. */
export function estimateMenuHeight(items: ReadonlyArray<{ kind: "item" | "separator" }>): number {
  return (
    MENU_PADDING +
    items.reduce((sum, item) => sum + (item.kind === "item" ? MENU_ITEM_HEIGHT : MENU_SEPARATOR_HEIGHT), 0)
  );
}

/**
 * How tall the notch window must be while a context menu is open. The menu cannot leave its
 * window, so the window grows to hold it (`anchorY` + the menu + a margin, or the bottom of the
 * extent the menu reported once placed) and never beyond `cap`; with no menu it is just `content`.
 */
export function menuWindowHeight(input: {
  content: number;
  cap: number;
  menu?: { anchorY: number; height: number } | null;
  extentBottom?: number | null;
}): number {
  const need = input.menu ? input.menu.anchorY + input.menu.height + MENU_MARGIN : 0;
  return Math.min(input.cap, Math.max(input.content, need, input.extentBottom ?? 0));
}

/** An open menu pins the quick look; closing it restores whatever it was before. */
export function pinDuringMenu(before: boolean, menuOpen: boolean): boolean {
  return menuOpen ? true : before;
}

/** The panel is asked to show a task, to edit it, or to ask before deleting it. */
export type RevealMode = "edit" | "delete";
export type RevealKind = "task" | "task_edit" | "task_delete";
export function revealKind(mode?: RevealMode): RevealKind {
  return mode === "edit" ? "task_edit" : mode === "delete" ? "task_delete" : "task";
}

/**
 * The pin after a menu closed. The menu pinned the quick look; closing it gives back the earlier
 * state, but only if the quick look is still open: it may have been closed (outside click, panel
 * opened, focus lost) while the menu was up, and a closed quick look must never stay pinned.
 */
export function restorePinAfterMenu(input: { before: boolean; expanded: boolean }): boolean {
  return input.expanded ? input.before : false;
}

/** A secondary press remembers the pin it found; the memory expires if no menu follows. */
export const PIN_MEMORY_MS = 1500;
export interface PinMemory { pinned: boolean; at: number }
export function rememberPin(pinned: boolean, now: number): PinMemory {
  return { pinned, at: now };
}
/** The remembered pin if it is still fresh, otherwise null (a menu opened by keyboard or touch must not use it). */
export function recallPin(memory: PinMemory | null, now: number): boolean | null {
  return memory && now - memory.at <= PIN_MEMORY_MS && now >= memory.at ? memory.pinned : null;
}

/** Where the pointer was last seen: by the page (DOM enter/leave) or by the host's own polling. */
export interface PointerSample { inside: boolean; at: number }
/** The host's `notch:pointer` yields to DOM events that arrived this recently. */
export const DOM_POINTER_PRIORITY_MS = 300;
/** The newest sample wins; a DOM event wins a tie and anything within DOM_POINTER_PRIORITY_MS. */
export function latestPointer(host: PointerSample | null, dom: PointerSample | null): PointerSample | null {
  if (!host) return dom;
  if (!dom) return host;
  return dom.at >= host.at - DOM_POINTER_PRIORITY_MS ? dom : host;
}
/**
 * Whether the pointer is outside the notch. In the native window the host's position and the
 * page's events are the evidence (the page's bounding box covers the whole window, so geometry
 * says nothing); the browser preview has no host and keeps using the geometry.
 */
export function pointerIsOutside(input: {
  native: boolean;
  geometryAway: boolean;
  host: PointerSample | null;
  dom: PointerSample | null;
}): boolean {
  if (!input.native) return input.geometryAway;
  const sample = latestPointer(input.host, input.dom);
  return sample ? !sample.inside : input.geometryAway;
}

/**
 * Windows has no global click monitor, so a click on the desktop never reaches the page. An open
 * menu (which pins the quick look) is therefore dropped once the host has reported the pointer
 * outside the window for this long. Unverified on real Windows hardware.
 */
export const MENU_ABSENCE_MS = 800;
export function menuAbandoned(input: {
  host: PointerSample | null;
  dom: PointerSample | null;
  now: number;
  threshold?: number;
}): boolean {
  const { host, dom } = input;
  if (!host || host.inside) return false;
  // The page saw the pointer come back after the host last said it was away.
  if (dom && dom.inside && dom.at > host.at) return false;
  return input.now - host.at >= (input.threshold ?? MENU_ABSENCE_MS);
}

/** Rows deferred under the pointer are listed live once the quick look opens, so nothing stays deferred. */
export function deferredAfterExpand<T>(deferred: T[], expanded: boolean): T[] {
  return expanded ? [] : deferred;
}

/**
 * A periodic reminder shown while the quick look had just closed has no DOM yet: the stack comes
 * back after STACK_RETURN_DELAY. The receipt waits for that instead of reporting a failure.
 */
export const PERIODIC_RENDER_STEP = 50;
export const PERIODIC_RENDER_MAX_WAIT = STACK_RETURN_DELAY + 300;
export function periodicRenderGate(input: {
  rendered: boolean;
  held: boolean;
  waited: number;
}): "show" | "wait" | "fail" {
  if (input.rendered) return "show";
  return input.held && input.waited < PERIODIC_RENDER_MAX_WAIT ? "wait" : "fail";
}

/**
 * One notch write at a time. `run` is for clicks (dropped while busy, the control is disabled
 * anyway); `whenIdle` is for work that must not be lost (an undo): it waits its turn and runs once.
 */
export class ActionGate {
  private current: Promise<void> | null = null;
  get busy() {
    return this.current !== null;
  }
  async run(action: () => Promise<void>): Promise<boolean> {
    if (this.current) return false;
    const running = action().finally(() => {
      if (this.current === running) this.current = null;
    });
    this.current = running;
    await running;
    return true;
  }
  async whenIdle(action: () => Promise<void>): Promise<void> {
    while (this.current) await this.current.catch(() => {});
    await this.run(action);
  }
}

/** What a failed notch call says, and whether the board must be re-read (someone else changed it). */
export function errorFeedback(error: unknown, language: string): { message: string; refresh: boolean } {
  return { message: describeError(error, language), refresh: isVersionConflict(error) };
}
