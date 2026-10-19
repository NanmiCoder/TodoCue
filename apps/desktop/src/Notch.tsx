import { useReducedMotion } from "./useReducedMotion.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type { PeriodicReminder, RuntimeEvent, Task } from "@todocue/shared";
import { listen } from "@tauri-apps/api/event";
import {
  client,
  defaults,
  loadSettings,
  loadNotchMetrics,
  type NotchMetrics,
  native,
  platform,
  openPanel,
  openTaskComposer,
  canShowNotch,
  presentNotch,
  revealTask,
  updateTray,
  type DesktopSettings,
} from "./bridge.js";
import {
  CueStack,
  visibleCues,
  taskCue,
  canPresentPeriodic,
  periodicActive,
  shouldCollapseQuickLook,
  shouldCollapseForPanel,
  shouldDeferArrival,
  freezeJoins,
  foldsStack,
  cueMeta,
  cuePose,
  rippleProgress,
  taskCountdown,
  STACK_MAX_HEIGHT,
  QUICK_LOOK_MAX_HEIGHT,
  STACK_RETURN_DELAY,
  PULSE_INTERVAL,
  estimateMenuHeight,
  menuWindowHeight,
  pinDuringMenu,
  restorePinAfterMenu,
  rememberPin,
  recallPin,
  pointerIsOutside,
  menuAbandoned,
  deferredAfterExpand,
  periodicRenderGate,
  PERIODIC_RENDER_STEP,
  ActionGate,
  errorFeedback,
  type PinMemory,
  type PointerSample,
  type QuickLookClose,
  type Cue,
} from "./model.js";
import { Gauge, Mark, Numeral, TaskRow } from "./components.js";
import { Icon } from "./icons.js";
import { TaskMetadata } from "./metadata.js";
import { rescheduleUndo } from "./dates.js";
import { taskCommands } from "./taskCommands.js";
import { taskMenuItems, type TaskMenuCommands } from "./taskMenu.js";
import { useContextMenu, type MenuAnchor } from "./ContextMenu.js";
import type { UndoAction } from "./toast.js";
import { translate } from "./i18n.js";
import { useRuntime } from "./useRuntime.js";
import { dial, motionTokens } from "./tokens.js";
import { isCompositionKey, QuickAddRequest } from "./quickAdd.js";

/** What the notch says about itself, with zh/en picked once. */
const pick = (language: string) => (zh: string, en: string) => (language === "en" ? en : zh);

function NotchCount({ value }: { value: number }) {
  return value > 99
    ? <span className="notch-overflow-count"><span aria-hidden="true">99+</span><span className="sr-only">{value}</span></span>
    : <Numeral value={value} />;
}

export function Notch() {
  const stack = useRef(new CueStack());
  const [cues, setCues] = useState<Cue[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [folded, setFolded] = useState(false);
  /** After the quick look closes the stack waits for the shell to shrink before it comes back. */
  const [stackHold, setStackHold] = useState(false);
  const stackHoldRef = useRef(false);
  const [featuredKey, setFeaturedKey] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [saving, setSaving] = useState(false);
  const quickInput = useRef<HTMLInputElement>(null);
  const quickRequest = useRef(new QuickAddRequest());
  const pendingFocus = useRef(false);
  const [focusTick, setFocusTick] = useState(0);
  const quickFocusRevision = useRef(0);
  const actionGate = useRef(new ActionGate());
  const busyCues = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [featured, setFeatured] = useState(false);
  const [cueHovered, setCueHovered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<NotchToast | null>(null);
  const contextMenu = useContextMenu();
  /** The window must hold an open (or opening) menu; null when there is none. */
  const menuFloor = useRef<{ anchorY: number; height: number } | null>(null);
  /** Pin state before the menu opened, restored when it closes; null while no menu is active. */
  const menuPin = useRef<{ before: boolean; opened: boolean } | null>(null);
  /** Pin state at the moment of a secondary press, before focusing the row could pin the quick look. */
  const pinBeforePress = useRef<PinMemory | null>(null);
  /** The latest pointer evidence: the host's `notch:pointer` and the page's own enter/leave. */
  const hostPointer = useRef<PointerSample | null>(null);
  const domPointer = useRef<PointerSample | null>(null);
  /** Last pointer position seen by the page: `:hover` lags a frame behind a removed menu. */
  const pointerPos = useRef<{ x: number; y: number } | null>(null);
  const presentNow = useRef<() => Promise<unknown>>(async () => undefined);
  const extentBottom = useRef<number | null>(null);
  extentBottom.current = contextMenu.extent?.bottom ?? null;
  const [deferredCount, setDeferredCount] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [settings, setSettings] = useState<DesktopSettings>(defaults);
  const [bandHeight, setBandHeight] = useState(32);
  const [compactWidth, setCompactWidth] = useState(229);
  const [housingWidth, setHousingWidth] = useState(185);
  const inFlight = useRef(new Set<string>());
  const content = useRef<HTMLDivElement>(null);
  const hovering = useRef(false),
    deferred = useRef<Cue[]>([]);
  const arrivals = useRef(new Map<string, number>());
  const lastPulse = useRef(Date.now());
  const panelVisible = useRef(false);
  const lastDomPointer = useRef(0);
  /** A DOM enter/leave: remembered for the host fallback to yield to, and for the pointer-outside check. */
  const markDom = (inside: boolean) => {
    const at = Date.now();
    lastDomPointer.current = at;
    domPointer.current = { inside, at };
  };
  const rearmAfterLeave = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const reduced = useReducedMotion();
  const displayState = useRef({
    enabled: settings.notchEnabled,
    expanded,
    hovered: false,
    foreground: true,
  });
  const interaction = useRef({ expanded, pinned });
  interaction.current = { expanded, pinned };
  displayState.current = {
    enabled: settings.notchEnabled,
    expanded,
    hovered: hovering.current,
    foreground: document.visibilityState === "visible",
  };
  const t = translate(settings.language);
  const n = pick(settings.language);
  stackHoldRef.current = stackHold;
  const stackShown = cues.length > 0 && !folded && !expanded && !stackHold;
  const stackShownRef = useRef(stackShown);
  stackShownRef.current = stackShown;
  /** Rows may leave under the pointer but none may join it (a click aimed at one must not land on another). */
  const joinsFrozen = () => stackShownRef.current && hovering.current;
  function commitCues() {
    const next = stack.current.shown().map((cue) => ({ ...cue }));
    setCues((current) => {
      const merged = joinsFrozen() ? freezeJoins(current, next) : next;
      return JSON.stringify(current) === JSON.stringify(merged) ? current : merged;
    });
  }
  function flushDeferred() {
    if (!deferred.current.length) return;
    setFeaturedKey(deferred.current.at(-1)!.key);
    setFeatured(true);
    deferred.current = [];
    setDeferredCount(0);
    commitCues();
  }
  // Opening the quick look lists every reminder live, so none is still waiting to join the stack.
  useEffect(() => {
    if (!expanded || !deferred.current.length) return;
    deferred.current = deferredAfterExpand(deferred.current, true);
    setDeferredCount(0);
    commitCues();
  }, [expanded]);
  function showToast(next: Omit<NotchToast, "id">) {
    clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ ...next, id });
    toastTimer.current = setTimeout(
      () => setToast((current) => (current?.id === id ? null : current)),
      next.undo ? 10000 : 4000,
    );
  }
  /**
   * Closing the quick look hands the screen back to the reminder stack; only the fold button
   * (`fold-button`) puts the stack into the wings.
   */
  function closeQuickLook(reason: QuickLookClose = "outside") {
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
    pendingFocus.current = false;
    quickFocusRevision.current++;
    rearmAfterLeave.current = hovering.current;
    interaction.current = { expanded: false, pinned: false };
    quickInput.current?.blur();
    setExpanded(false);
    setPinned(false);
    if (foldsStack(reason)) {
      lastPulse.current = Date.now();
      setFolded(true);
    } else {
      setStackHold(true);
      clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(() => setStackHold(false), STACK_RETURN_DELAY);
    }
  }
  function focusQuickAdd() {
    pendingFocus.current = true;
    interaction.current = { expanded: true, pinned: true };
    clearTimeout(leaveTimer.current);
    setExpanded(true);
    setPinned(true);
    // Already presented: ask the host for the keyboard, then return to the field.
    if (expanded && pinned) {
      quickInput.current?.focus();
      setFocusTick((value) => value + 1);
    }
  }
  /** Opened on purpose from the stack: it stays until Esc or a click outside; the keyboard is left alone. */
  function openQuickLookFromStack() {
    if (!stackShownRef.current) return;
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
    pendingFocus.current = false;
    interaction.current = { expanded: true, pinned: true };
    setExpanded(true);
    setPinned(true);
  }
  function collapseOutside() {
    if (!shouldCollapseQuickLook("outside", { ...interaction.current, editing: false })) return;
    closeQuickLook("outside");
    hovering.current = false;
    setCueHovered(false);
    flushDeferred();
  }
  const outside = useRef(collapseOutside);
  outside.current = collapseOutside;
  function pointerEnter() {
    if (hovering.current) return;
    hovering.current = true;
    setCueHovered(true);
    clearTimeout(leaveTimer.current);
    if (!expanded && !stackShown && !rearmAfterLeave.current)
      hoverTimer.current = setTimeout(() => {
        // The pointer may have left, or the panel opened, while the delay ran.
        if (hovering.current && !panelVisible.current) setExpanded(true);
      }, dial.hoverDelay);
  }
  function pointerLeave() {
    if (!hovering.current) return;
    hovering.current = false;
    setCueHovered(false);
    rearmAfterLeave.current = false;
    clearTimeout(hoverTimer.current);
    flushDeferred();
    leaveTimer.current = setTimeout(() => {
      if (shouldCollapseQuickLook("leave", { ...interaction.current, editing: document.activeElement === quickInput.current })) closeQuickLook("leave");
    }, dial.leaveDelay);
  }
  const pointer = useRef({ enter: pointerEnter, leave: pointerLeave });
  pointer.current = { enter: pointerEnter, leave: pointerLeave };
  useEffect(() => {
    const track = (event: PointerEvent) => { pointerPos.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener("pointermove", track, true);
    window.addEventListener("pointerdown", track, true);
    return () => {
      window.removeEventListener("pointermove", track, true);
      window.removeEventListener("pointerdown", track, true);
    };
  }, []);
  useEffect(() => {
    if (native) return;
    const blur = () => outside.current();
    const click = (event: PointerEvent) => {
      // The menu is portaled out of `.notch` but belongs to it: pressing it is not an outside click.
      if (event.target instanceof Element && event.target.closest("[data-context-menu]")) return;
      if (event.target instanceof Node && !document.querySelector(".notch")?.contains(event.target)) outside.current();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("pointerdown", click);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("pointerdown", click);
    };
  }, []);
  useEffect(() => {
    let ended = false;
    let stop: (() => void) | undefined;
    const update = (metrics: NotchMetrics) => {
      if (!ended && Number.isFinite(metrics.bandHeight)) setBandHeight(metrics.bandHeight);
      if (!ended && Number.isFinite(metrics.compactWidth)) setCompactWidth(metrics.compactWidth);
      if (!ended && Number.isFinite(metrics.housingWidth)) setHousingWidth(metrics.housingWidth);
    };
    void (async () => {
      if (native) {
        const listener = await listen<NotchMetrics>("notch:metrics", event => update(event.payload));
        if (ended) { listener(); return; }
        stop = listener;
      }
      update(await loadNotchMetrics());
    })().catch(error => { if (!ended) setError(String(error)); });
    return () => { ended = true; stop?.(); };
  }, []);
  function arrival(cue: Omit<Cue, "repeats">) {
    const listed = stack.current.entries.some((item) => item.key === cue.key);
    if (!stack.current.receive(cue)) return;
    arrivals.current.set(cue.key, Date.now());
    setFolded(false);
    setAnnouncement(n(`TodoCue 提醒：${cue.title}`, `TodoCue reminder: ${cue.title}`));
    if (
      shouldDeferArrival({
        stackShown: stackShownRef.current,
        pointerOnStack: hovering.current,
        alreadyListed: listed,
      })
    ) {
      deferred.current.push(stack.current.entries.find((item) => item.key === cue.key)!);
      setDeferredCount(deferred.current.length);
    } else {
      setFeaturedKey(cue.key);
      setFeatured(true);
      commitCues();
    }
  }
  const active = periodicActive;
  const eventHandler = useRef<(event: RuntimeEvent) => void>(() => {});
  const runtime = useRuntime((event) => eventHandler.current(event));
  /** Menus and queued work outlive the render that built them: they read these, never a snapshot. */
  const boardRef = useRef(runtime.board);
  boardRef.current = runtime.board;
  const onlineRef = useRef(runtime.connection.online);
  onlineRef.current = runtime.connection.online;
  const failRef = useRef<(error: unknown) => void>(() => {});
  failRef.current = (error) => {
    const feedback = errorFeedback(error, settings.language);
    setError(feedback.message);
    // Someone else changed it: re-read, so a retry carries the current version.
    if (feedback.refresh) void runtime.refresh();
  };
  const fail = (error: unknown) => failRef.current(error);
  eventHandler.current = (event) => {
    if (event.type === "reminder.fired" && event.related?.taskId) {
      void client
        .getTask(event.related.taskId)
        .then(({ task }) => {
          const cue = taskCue(event, task);
          if (cue) arrival(cue);
        })
        .catch(fail);
    }
    if (event.type === "periodic.fired" && event.id) void claim(event.id);
  };
  async function claim(id: string) {
    if (
      !canPresentPeriodic({
        ...displayState.current,
        hovered: hovering.current,
      }) ||
      inFlight.current.has(id)
    )
      return;
    const key = `periodic:${id}`;
    if (!stack.current.reserve(key)) return;
    inFlight.current.add(id);
    try {
      const { reminder: rule } = await client.getPeriodicReminder(id);
      const occurrence = rule.currentOccurrence;
      if (
        !occurrence ||
        occurrence.delivery !== "offered" ||
        !occurrence.offeredAt ||
        Date.now() - Date.parse(occurrence.offeredAt) >= 3000 ||
        !active(rule)
      )
        return;
      const possible = await canShowNotch();
      if (!possible || !canPresentPeriodic({ ...displayState.current, hovered: hovering.current })) return;
      const claim = {
        occurrenceId: occurrence.id,
        round: occurrence.round,
        token: crypto.randomUUID(),
      };
      const { reminder } = await client.claimPeriodic(id, claim);
      if (
        !canPresentPeriodic({
          ...displayState.current,
          hovered: hovering.current,
        })
      ) {
        await client.receiptPeriodic(id, { ...claim, displayed: false });
        return;
      }
      // The quick look may have just closed: the stack then comes back after a short hold.
      const heldAtArrival = stackHoldRef.current;
      arrival({
        key: `periodic:${id}`,
        id: `${occurrence.id}:${occurrence.round}`,
        title: rule.title,
        periodic: reminder,
        receivedAt: Date.now(),
      });
      // The DOM has painted before acknowledging successful display to the runtime.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const isRendered = () =>
        !!content.current?.querySelector(`[data-cue-id="${occurrence.id}:${occurrence.round}"]`);
      let rendered = isRendered();
      // During the hold there is nothing to paint yet. Wait for the stack instead of reporting a
      // failure, which would drop a reminder the person never got to see.
      for (
        let waited = 0;
        periodicRenderGate({ rendered, held: heldAtArrival || stackHoldRef.current, waited }) === "wait" &&
        canPresentPeriodic({ ...displayState.current, hovered: hovering.current });
        waited += PERIODIC_RENDER_STEP
      ) {
        await new Promise((resolve) => setTimeout(resolve, PERIODIC_RENDER_STEP));
        rendered = isRendered();
      }
      const displayed =
        rendered &&
        canPresentPeriodic({
          ...displayState.current,
          hovered: hovering.current,
        }) &&
        (await presentNotch({
          width: 460,
          height: Math.min(content.current?.scrollHeight ?? 190, STACK_MAX_HEIGHT),
          expanded: false,
          pinned: false,
          stack: true,
        }));
      await client.receiptPeriodic(id, { ...claim, displayed });
      if (!displayed) {
        stack.current.entries = stack.current.entries.filter(
          (cue) => cue.id !== `${occurrence.id}:${occurrence.round}`,
        );
        commitCues();
      }
    } catch (error) {
      fail(error);
    } finally {
      inFlight.current.delete(id);
      stack.current.release(key);
    }
  }
  useEffect(() => {
    void loadSettings().then(setSettings);
    let stop: (() => void) | undefined;
    let ended = false;
    if (native)
      void Promise.all([
        listen<DesktopSettings>("settings:changed", (event) =>
          setSettings(event.payload),
        ),
        // The panel opened (or the space changed): only an open quick look closes, and the
        // reminder stack stays where it is.
        listen("notch:collapse", () => {
          if (shouldCollapseForPanel(interaction.current)) closeQuickLook("panel-opened");
        }),
        listen("notch:outside", () => outside.current()),
        listen("notch:focus", () => {
          if (interaction.current.expanded && pendingFocus.current) quickInput.current?.focus();
        }),
        // Host-side pointer position: a fallback for when the WebView gets no mouse events
        // (the app is not active). DOM events win while they are arriving.
        listen<{ inside: boolean }>("notch:pointer", (event) => {
          hostPointer.current = { inside: event.payload.inside, at: Date.now() };
          if (Date.now() - lastDomPointer.current < 300) return;
          if (event.payload.inside) pointer.current.enter();
          else pointer.current.leave();
        }),
        listen<{ visible: boolean }>("panel:visibility", (event) => {
          panelVisible.current = event.payload.visible;
        }),
        listen("tray:reconnect", () => void runtime.refresh()),
      ]).then((stops) => {
        const dispose = () => stops.forEach((stop) => stop());
        if (ended) dispose();
        else stop = dispose;
      });
    return () => {
      ended = true;
      stop?.();
      clearTimeout(hoverTimer.current);
      clearTimeout(leaveTimer.current);
      clearTimeout(holdTimer.current);
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (native) void invoke<boolean>("panel_visible").then((visible) => { panelVisible.current = visible; }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!runtime.board) return;
    stack.current.sync(runtime.board.all, runtime.rules);
    for (const rule of runtime.rules) {
      const occurrence = rule.currentOccurrence;
      if (
        occurrence?.delivery === "displayed" &&
        occurrence.result === "pending" &&
        rule.enabled &&
        active(rule) &&
        !rule.state.startsWith("paused")
      ) {
        stack.current.receive({
          key: `periodic:${rule.id}`,
          id: `${occurrence.id}:${occurrence.round}`,
          title: rule.title,
          periodic: rule,
          receivedAt: Date.now(),
        });
      }
    }
    commitCues();
  }, [runtime.board, runtime.rules]);
  useEffect(() => {
    const timer = setInterval(() => {
      stack.current.sync(runtime.board?.all ?? [], runtime.rules);
      commitCues();
      setNow(Date.now());
      // A folded stack breathes once in a while so it does not become wallpaper.
      if (
        !stackShownRef.current &&
        !interaction.current.expanded &&
        stack.current.shown().length > 0 &&
        Date.now() - lastPulse.current >= PULSE_INTERVAL
      ) {
        lastPulse.current = Date.now();
        setPulse((value) => value + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [runtime.board, runtime.rules]);
  useEffect(() => {
    if (!featured || cueHovered || busyKeys.size > 0) return;
    const timer = setTimeout(() => setFeatured(false), dial.featureDuration);
    return () => clearTimeout(timer);
  }, [featured, featuredKey, cueHovered, busyKeys.size, cues.find((cue) => cue.key === featuredKey)?.id]);
  const stackCues = visibleCues(cues, featured ? featuredKey : null);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    let active = true;
    // Keyboard input must work while the shell is growing, before it reaches full size.
    if (expanded && pendingFocus.current) quickInput.current?.focus();
    const resize = () => {
      const width = expanded ? 560 : stackShown ? 460 : settings.notchPlacement === "top" ? compactWidth : 88;
      // An open context menu is part of the window: it grows to hold it, then shrinks back.
      const height = expanded
        ? menuWindowHeight({
            content: node.scrollHeight,
            cap: QUICK_LOOK_MAX_HEIGHT,
            menu: menuFloor.current,
            extentBottom: extentBottom.current,
          })
        : stackShown
          ? Math.min(node.scrollHeight, STACK_MAX_HEIGHT)
          : bandHeight;
      return presentNotch({
        width,
        height,
        expanded,
        pinned,
        stack: stackShown,
        focus: expanded && pendingFocus.current,
      }).then((presented) => {
        // AX/DOM elements can exist before the native window has grown around them.
        if (active && presented && interaction.current.expanded && pendingFocus.current) {
          pendingFocus.current = false;
          if (!document.hasFocus()) quickInput.current?.blur();
          if (document.activeElement !== quickInput.current || !document.hasFocus()) quickInput.current?.focus();
        }
        return presented;
      }).catch((error) => { if (active) fail(error); });
    };
    presentNow.current = async () => resize();
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => { active = false; observer.disconnect(); };
  }, [expanded, pinned, stackShown, featured, cues, settings, bandHeight, compactWidth, focusTick, toast, deferredCount, contextMenu.extent]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isCompositionKey(event)) {
        event.preventDefault();
        if (quick) { quickRequest.current.edited(); setQuick(""); }
        // A draft goes first; then the quick look closes and the reminders stay.
        else if (interaction.current.expanded) closeQuickLook("escape");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [quick]);
  async function answer(
    cue: Cue,
    action: "complete" | "snooze" | "pause_today",
  ) {
    if (!runtime.connection.online || busyCues.current.has(cue.key)) return;
    busyCues.current.add(cue.key);
    setBusyKeys(new Set(busyCues.current));
    try {
      if (action === "complete")
        await new Promise((resolve) =>
          setTimeout(resolve, reduced ? 120 : 420),
        );
      if (cue.task) {
        if (action === "complete")
          await client.completeTask(cue.task.id, {
            expectedVersion: cue.task.version,
          });
        else
          await client.snoozeTask(cue.task.id, {
            expectedVersion: cue.task.version,
            minutes: 10,
          });
      } else if (cue.periodic)
        await client.periodicAction(cue.periodic.id, {
          action,
          expectedVersion: cue.periodic.version,
          occurrenceId: cue.periodic.currentOccurrenceId ?? undefined,
          round: cue.periodic.currentOccurrence?.round,
          minutes: action === "snooze" ? 10 : undefined,
        });
      stack.current.entries = stack.current.entries.filter(
        (item) => item.key !== cue.key,
      );
      commitCues();
      await runtime.refresh();
    } catch (error) {
      fail(error);
    } finally {
      busyCues.current.delete(cue.key);
      setBusyKeys(new Set(busyCues.current));
    }
  }
  const next = runtime.board?.next.next?.task;
  const rows =
    runtime.board?.today.items
      .filter((item) => item.task.id !== next?.id)
      .slice(0, 5) ?? [];
  async function performAction(action: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await action();
      await runtime.refresh();
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  }
  /** A click: dropped while another write is in flight (its control is disabled anyway). */
  async function taskAction(action: () => Promise<unknown>) {
    if (!onlineRef.current) return;
    await actionGate.current.run(() => performAction(action));
  }
  const remaining = runtime.board?.today.remaining ?? 0;
  const nextTitle = next?.title ?? null;
  const nextId = next?.id ?? null;
  const online = runtime.connection.online;
  useEffect(() => {
    if (!native) return;
    void updateTray({
      language: settings.language,
      remaining,
      online,
      nextTitle,
      nextId,
    }).catch(() => {});
  }, [settings.language, remaining, online, nextTitle, nextId]);
  const tomorrow = () => {
    const today = boardRef.current?.context.today;
    if (!today) throw new Error("The board has not loaded yet");
    return today;
  };
  /** The freshest copy of a task, read when the action runs (a menu may have been open for a while). */
  const latest = (task: Task) => boardRef.current?.all.find((item) => item.id === task.id) ?? task;
  async function completeWithFeedback(given: Task, beat = true) {
    if (beat) await new Promise((resolve) => setTimeout(resolve, reduced ? 120 : 420));
    const task = latest(given);
    const { task: after } = await client.completeTask(task.id, { expectedVersion: task.version });
    showToast({
      message: n(`已完成「${task.title}」`, `Completed “${task.title}”`),
      undo: { kind: "reopen", taskId: task.id, version: after.version },
    });
  }
  async function snoozeWithFeedback(task: Task) {
    await taskCommands.snooze(latest(task));
    showToast({ message: n("将在 10 分钟后提醒", "Reminder set for 10 minutes from now") });
  }
  /** The deadline may move with the plan, so the undo restores both. */
  async function tomorrowWithFeedback(task: Task) {
    const before = latest(task);
    const { task: after } = await taskCommands.tomorrow(before, tomorrow());
    showToast({ message: n("已改期到明天", "Rescheduled to tomorrow"), undo: rescheduleUndo(before, after) });
  }
  function undoToast(action: UndoAction) {
    clearTimeout(toastTimer.current);
    setToast(null);
    if (!onlineRef.current) return;
    // An undo is never dropped because the action it undoes is still refreshing: it waits its turn.
    void actionGate.current.whenIdle(() => performAction(async () => {
      if (action.kind === "reopen") await client.reopenTask(action.taskId, { expectedVersion: action.version });
      else if (action.kind === "reschedule")
        await client.updateTask(action.taskId, {
          expectedVersion: action.expectedVersion,
          scheduledDate: action.scheduledDate,
          scheduledAt: action.scheduledAt,
          ...("dueDate" in action ? { dueDate: action.dueDate, dueAt: action.dueAt } : {}),
          ...(action.scheduledAt || action.dueAt ? { timezone: action.timezone } : {}),
        });
    }));
  }
  // The row menu: the panel's items, run here. "Edit…" and "Delete…" need the panel, which opens
  // on the form or on the confirmation (deleting is permanent, so it always asks first).
  const menuCommands: TaskMenuCommands = {
    complete: (task) => void taskAction(() => completeWithFeedback(latest(task), false)),
    snooze: (task) => void taskAction(() => snoozeWithFeedback(task)),
    tomorrow: (task) => void taskAction(() => tomorrowWithFeedback(task)),
    edit: (task) => void revealTask(task.id, "edit").catch(fail),
    cancel: (task) => void taskAction(() => taskCommands.cancel(latest(task))),
    skip: (task) => void taskAction(() => taskCommands.skip(latest(task))),
    reopen: (task) => void taskAction(() => taskCommands.reopen(latest(task))),
    requestDelete: (task) => void revealTask(task.id, "delete").catch(fail),
  };
  /**
   * Open the menu once the window can hold it: growing the window resizes the WebView, which
   * would dismiss a menu that was already open, so the menu waits for the new size. The quick look
   * is pinned for as long as the menu is up.
   */
  async function openTaskMenu(task: Task, anchor: MenuAnchor) {
    const items = taskMenuItems(task, { language: settings.language, online, busy: saving, commands: menuCommands });
    const floor = { anchorY: anchor.y, height: estimateMenuHeight(items) };
    // Only a fresh memory of a secondary press counts; a menu opened by keyboard or touch has none.
    const remembered = recallPin(pinBeforePress.current, Date.now());
    if (!menuPin.current) menuPin.current = { before: remembered ?? interaction.current.pinned, opened: false };
    pinBeforePress.current = null;
    clearTimeout(leaveTimer.current);
    interaction.current.pinned = pinDuringMenu(menuPin.current.before, true);
    setPinned(true);
    menuFloor.current = floor;
    await presentNow.current();
    const wanted = menuWindowHeight({ content: 0, cap: QUICK_LOOK_MAX_HEIGHT, menu: floor });
    // The native window has resized; wait until the page reports it before placing the menu.
    for (let waited = 0; native && window.innerHeight < wanted - 1 && waited < 600; waited += 16)
      await new Promise((resolve) => setTimeout(resolve, 16));
    if (native) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!menuPin.current) return;
    menuPin.current.opened = true;
    contextMenu.open(anchor, items, task.title);
  }
  // Closing the menu gives the window back its height and the quick look its earlier pin state.
  useEffect(() => {
    const session = menuPin.current;
    if (contextMenu.isOpen || !session?.opened) return;
    menuPin.current = null;
    menuFloor.current = null;
    // The quick look may have closed while the menu was up (outside click, the panel opened): then
    // there is nothing left to pin.
    const stillOpen = interaction.current.expanded;
    const restored = restorePinAfterMenu({ before: pinDuringMenu(session.before, false), expanded: stillOpen });
    interaction.current.pinned = restored;
    setPinned(restored);
    setFocusTick((value) => value + 1);
    if (!stillOpen) return;
    // The pointer may have left while the menu was up, and the page never saw it leave. In the
    // native window the page's box is the whole window, so geometry says nothing there: the host's
    // `notch:pointer` and the page's enter/leave decide. The browser preview still asks geometry.
    const box = document.querySelector(".notch")?.getBoundingClientRect();
    const at = pointerPos.current;
    const geometryAway = !!box && !!at && (at.x < box.left || at.x >= box.right || at.y < box.top || at.y >= box.bottom);
    const away = pointerIsOutside({ native, geometryAway, host: hostPointer.current, dom: domPointer.current });
    if (!restored && away) {
      if (hovering.current) {
        markDom(false);
        pointer.current.leave();
      } else {
        // Already counted as gone while the menu held the pin; start the timer that pin cancelled.
        clearTimeout(leaveTimer.current);
        leaveTimer.current = setTimeout(() => {
          if (shouldCollapseQuickLook("leave", { ...interaction.current, editing: document.activeElement === quickInput.current })) closeQuickLook("leave");
        }, dial.leaveDelay);
      }
    }
  }, [contextMenu.isOpen]);
  // Windows has no global click monitor, so a click on the desktop never reaches the page and an
  // abandoned menu would hold the quick look open for good. While a menu is up, the host's report
  // of the pointer being outside the window for MENU_ABSENCE_MS closes it (the usual restore and
  // leave timer then follow). Harmless on macOS. Not verified on real Windows hardware.
  useEffect(() => {
    if (!contextMenu.isOpen || !native) return;
    const close = contextMenu.close;
    const timer = setInterval(() => {
      if (menuAbandoned({ host: hostPointer.current, dom: domPointer.current, now: Date.now() })) close();
    }, 200);
    return () => clearInterval(timer);
  }, [contextMenu.isOpen]);
  // A menu belongs to the quick look and to one connection state.
  useEffect(() => {
    if (!expanded || !online) {
      contextMenu.close();
      if (menuPin.current && !menuPin.current.opened) { menuPin.current = null; menuFloor.current = null; }
    }
  }, [expanded, online]);
  const resting = stackCues.length;
  const folding = cues.length - resting;
  const countdown = next ? taskCountdown(next, now, settings.language) : null;
  const nextReason = runtime.board?.next.next?.group === "overdue" ? t("overdue")
    : runtime.board?.next.next?.group === "due_today" ? t("must")
    : runtime.board?.next.next?.group === "scheduled_reached" ? n("已到计划时间", "Planned time reached")
    : n("未安排", "Unscheduled");
  return (
    <motion.main
      className={`notch notch-${settings.notchPlacement} ${expanded || stackShown ? "notch-open" : ""}`}
      animate={{
        borderTopLeftRadius: settings.notchPlacement === "right" ? (expanded || stackShown ? 24 : 12) : 0,
        borderTopRightRadius: settings.notchPlacement === "left" ? (expanded || stackShown ? 24 : 12) : 0,
        borderBottomLeftRadius: settings.notchPlacement === "left" ? 0 : expanded || stackShown ? 24 : 12,
        borderBottomRightRadius: settings.notchPlacement === "right" ? 0 : expanded || stackShown ? 24 : 12,
      }}
      transition={reduced ? { duration: 0.12 } : motionTokens.expand}
      onMouseEnter={() => {
        markDom(true);
        pointer.current.enter();
      }}
      onMouseLeave={() => {
        markDom(false);
        pointer.current.leave();
      }}
    >
      <div
        ref={content}
        style={{ width: expanded ? 560 : stackShown ? 460 : settings.notchPlacement === "top" ? compactWidth : 88 }}
      >
        <button
          className="notch-band"
          style={{ height: bandHeight }}
          onClick={() => (stackShown ? openQuickLookFromStack() : focusQuickAdd())}
          aria-label={
            cues.length > 0
              ? n(`${cues.length} 项提醒等你处理，今日剩余 ${remaining} 项，悬停或点击展开`, `${cues.length} reminders waiting, ${remaining} left today. Hover or click to open.`)
              : t("showPanel")
          }
        >
          <span className="notch-wing notch-wing-left">
            {cues.length > 0 ? (
              <span className="notch-badge">
                {pulse > 0 && !reduced && (
                  <motion.span
                    key={pulse}
                    className="notch-pulse"
                    initial={{ scale: 1, opacity: 0.8 }}
                    animate={{ scale: 1.7, opacity: 0 }}
                    transition={{ duration: 0.9, ease: "easeOut" }}
                  />
                )}
                <NotchCount value={cues.length} />
              </span>
            ) : (
              <Mark />
            )}
          </span>
          <span className="notch-housing" aria-hidden="true" style={{ height: bandHeight, width: settings.notchPlacement === "top" ? housingWidth : 0 }} />
          <span className="notch-wing notch-count">
            {!online ? (
              <svg className="notch-offline" viewBox="0 0 24 24" aria-label={t("offline")}>
                <path d="M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9.500 17a4 4 0 0 1 5 0M4 4l16 16" />
              </svg>
            ) : runtime.board ? (
              <NotchCount value={remaining} />
            ) : (
              "—"
            )}
          </span>
        </button>
        <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
        <AnimatePresence initial={false}>
          {(expanded || stackShown) && (
            <NotchSurface
              mode={expanded ? "quick" : "stack"}
              bandHeight={bandHeight}
              onSecondaryPress={() => { pinBeforePress.current = rememberPin(interaction.current.pinned, Date.now()); }}
              onPlainPress={() => { pinBeforePress.current = null; }}
              reduced={!!reduced}
              onPin={(target) => {
                if (target instanceof Element && !target.closest(".notch-quick-field")) {
                  pendingFocus.current = false;
                  quickFocusRevision.current++;
                }
                // Typing needs the keyboard: ask the host for it only when the field is touched.
                if (target instanceof Element && target.closest(".notch-quick-field")) {
                  pendingFocus.current = true;
                  setFocusTick((value) => value + 1);
                }
                if (expanded && !(target instanceof Element && target.closest("[data-pin-control]"))) {
                  clearTimeout(leaveTimer.current);
                  interaction.current.pinned = true;
                  setPinned(true);
                }
              }}
              key={expanded ? "quick" : "stack"}
            >
              {expanded ? (
                <>
                  <div className="notch-toast-slot">
                  <AnimatePresence initial={false}>
                    {toast && (
                      <motion.div
                        key={toast.id}
                        className="notch-toast"
                        role="status"
                        initial={reduced ? { opacity: 0 } : { opacity: 0, y: -14 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, transition: { duration: 0.12 } }}
                        transition={reduced ? { duration: 0.12 } : motionTokens.snap}
                      >
                        <Icon name="check" size={14} />
                        <span>{toast.message}</span>
                        {toast.undo && (
                          <button onClick={() => undoToast(toast.undo!)} disabled={!online}>
                            {n("撤销", "Undo")}
                          </button>
                        )}
                        <button className="notch-toast-close" onClick={() => setToast(null)} aria-label={n("关闭提示", "Dismiss")}>
                          <Icon name="close" size={10} />
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  </div>
                  <div className={`notch-quick-header ${toast ? "is-covered" : ""}`} aria-hidden={!!toast}>
                    <Mark />
                    <div>
                      <strong>
                        {n("今天", "Today")}
                      </strong>
                      <span>
                        {runtime.board &&
                          new Intl.DateTimeFormat(settings.language, {
                            month: "short",
                            day: "numeric",
                            weekday: "short",
                            timeZone: runtime.board.context.timezone,
                          }).format(new Date(runtime.board.context.now))}
                      </span>
                    </div>
                    <div className="notch-progress">
                    <Gauge
                      showsLabel={false}
                      diameter={24}
                      ready={!!runtime.board}
                      completed={runtime.board?.today.completed.length ?? 0}
                      total={
                        (runtime.board?.today.remaining ?? 0) +
                        (runtime.board?.today.completed.length ?? 0)
                      }
                    />
                    <span>{runtime.board?.today.remaining
                      ? n(`还剩 ${runtime.board.today.remaining} 件`, `${runtime.board.today.remaining} left`)
                      : runtime.board?.today.completed.length ? n("已清空", "All clear") : n("暂无待办", "Nothing planned")}</span>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => void openTaskComposer()}
                      aria-label={t("newTask")}
                    >
                      <Icon name="plus" />
                    </button>
                    <button
                      className={`icon-button ${pinned ? "accent" : ""}`}
                      data-pin-control
                      onClick={() => {
                        const value = !pinned;
                        interaction.current.pinned = value;
                        setPinned(value);
                      }}
                      aria-pressed={pinned}
                      aria-label={
                        pinned ? n("取消固定快览", "Unpin quick look") : n("固定快览", "Pin quick look")
                      }
                    >
                      <Icon name="pin" />
                    </button>
                  </div>
                  {!online && (
                    <p className="notch-notice">
                      {t("offline")}
                      <button onClick={() => void runtime.refresh()}>
                        {n("重连", "Reconnect")}
                      </button>
                    </p>
                  )}
                  {cues.length > 0 && (
                    <section className="notch-pending" aria-label={n("待你回应", "Waiting for you")}>
                      <h3>
                        {n("待你回应", "Waiting for you")} <span>{cues.length}</span>
                      </h3>
                      <AnimatePresence initial={false}>
                        {cues.map((cue) => (
                          <CueCard
                            key={cue.key}
                            cue={cue}
                            featured={false}
                            language={settings.language}
                            now={now}
                            arrivedAt={arrivals.current.get(cue.key) ?? cue.receivedAt}
                            disabled={!online || busyKeys.has(cue.key)}
                            completing={busyKeys.has(cue.key)}
                            onOpen={() =>
                              cue.task ? void revealTask(cue.task.id) : void openPanel()
                            }
                            onAnswer={(action) => void answer(cue, action)}
                            onFold={() => {}}
                          />
                        ))}
                      </AnimatePresence>
                    </section>
                  )}
                  {next && (
                    <section className="notch-next">
                      <div className="next-heading">
                        <span className="eyebrow">NEXT</span>
                        <span>{t("next")}</span>
                        <span className={`notch-next-reason ${countdown?.late || runtime.board?.next.next?.group === "overdue" ? "is-late" : ""}`}>
                          {countdown?.text ?? nextReason}
                        </span>
                      </div>
                      <button
                        className="next-title"
                        onClick={() => void revealTask(next.id)}
                      >
                        {next.title}
                      </button>
                      <TaskMetadata
                        task={next}
                        language={settings.language}
                        today={runtime.board?.context.today}
                      />
                      <div className="notch-next-actions">
                        <button
                          className="pill"
                          disabled={!online || saving}
                          onClick={() =>
                            void taskAction(() => completeWithFeedback(latest(next)))
                          }
                        >
                          <span className="orange-disc">
                            <Icon name="check" />
                          </span>
                          {t("complete")}
                        </button>
                        <button
                          className="pill secondary"
                          disabled={!online || saving}
                          onClick={() =>
                            void taskAction(() => snoozeWithFeedback(next))
                          }
                        >
                          <span className="quiet-disc"><Icon name="snooze" size={10} /></span>
                          {n("10 分钟后提醒", "Remind in 10 minutes")}
                        </button>
                        <button
                          className="pill secondary"
                          disabled={!online || saving}
                          onClick={() =>
                            void taskAction(() => tomorrowWithFeedback(next))
                          }
                        >
                          <span className="quiet-disc"><Icon name="tomorrow" size={10} /></span>
                          {n("明天", "Tomorrow")}
                        </button>
                        <button
                          className="icon-button"
                          onClick={() => void revealTask(next.id)}
                          aria-label={t("details")}
                        >
                          <Icon name="chevron" />
                        </button>
                      </div>
                    </section>
                  )}
                  <div className="notch-today-rows">
                    {["overdue", "must", "scheduled"].map((section) => {
                      const group = rows.filter(
                        (item) => item.section === section,
                      );
                      return (
                        group.length > 0 && (
                          <section key={section}>
                            <h3>
                              {t(section as "overdue" | "must" | "scheduled")}{" "}
                              <span>{group.length}</span>
                            </h3>
                            {group.map(({ task }) => (
                              <TaskRow
                                key={task.id}
                                task={task}
                                today={runtime.board?.context.today}
                                disabled={!online || saving}
                                onMenu={(task, anchor) => void openTaskMenu(task, anchor)}
                                onComplete={async (task) => {
                                  try {
                                    await completeWithFeedback(latest(task), false);
                                    await runtime.refresh();
                                  } catch (error) {
                                    fail(error);
                                    return false;
                                  }
                                }}
                                onOpen={(task) => void revealTask(task.id)}
                                trailingActions={<>
                                  <button className="icon-button" disabled={!online || saving}
                                    aria-label={`${t("snooze")} ${task.title}`}
                                    onClick={() => void taskAction(() => snoozeWithFeedback(task))}>
                                    <Icon name="snooze" size={13} />
                                  </button>
                                  <button className="icon-button" disabled={!online || saving}
                                    aria-label={`${n("改期到明天", "Move to tomorrow")} ${task.title}`}
                                    onClick={() => void taskAction(() => tomorrowWithFeedback(task))}>
                                    <Icon name="tomorrow" size={13} />
                                  </button>
                                </>}
                              />
                            ))}
                          </section>
                        )
                      );
                    })}
                  </div>
                  {!next && rows.length === 0 && (
                    <div className="notch-empty">
                      <span className="orange-disc"><Icon name={runtime.board?.today.completed.length ? "check" : "plus"} size={15} /></span>
                      <div><strong>{runtime.board?.today.completed.length ? n("今天已清空", "All clear today") : n("今天还没有安排", "Nothing planned today")}</strong>
                        <p>{n("在下方记一件事，回车就加到今天。", "Add a task below, then press Enter.")}</p></div>
                    </div>
                  )}
                  {(runtime.board?.today.items.length ?? 0) >
                    rows.length + (next ? 1 : 0) && (
                    <button
                      className="text-button notch-more"
                      onClick={() => void openPanel()}
                    >
                      {settings.language === "en"
                        ? "See all tasks"
                        : `还有 ${(runtime.board?.today.items.length ?? 0) - rows.length - (next ? 1 : 0)} 项，查看全部`}
                    </button>
                  )}
                  <form
                    className="notch-quick-add"
                    aria-busy={saving}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!quick.trim() || actionGate.current.busy || !runtime.connection.online)
                        return;
                      const submitter = (event.nativeEvent as SubmitEvent).submitter;
                      const focusRevision = quickFocusRevision.current;
                      const ownsFocus = document.activeElement === quickInput.current ||
                        document.activeElement === submitter || (!!submitter && document.activeElement === document.body);
                      const title = quick,
                        payload = {
                          title,
                          scheduledDate: runtime.board?.context.today,
                        };
                      const operation = quickRequest.current.begin(payload);
                      if (!operation) return;
                      if (ownsFocus) quickInput.current?.focus();
                      void taskAction(async () => {
                        try {
                          await client.createTask(payload, { idempotencyKey: operation.key });
                          const restoreFocus = ownsFocus && interaction.current.expanded && quickFocusRevision.current === focusRevision && (
                            document.activeElement === quickInput.current || document.activeElement === submitter ||
                            document.activeElement === document.body
                          );
                          if (quickRequest.current.commit(operation)) setQuick("");
                          // Saving must not reclaim focus after an outside click or another control.
                          if (restoreFocus) requestAnimationFrame(() => {
                            if (interaction.current.expanded && quickFocusRevision.current === focusRevision)
                              quickInput.current?.focus();
                          });
                        } finally { quickRequest.current.settle(); }
                      });
                    }}
                  >
                    <div className={`notch-quick-field ${quick.trim() ? "has-text" : ""}`}>
                    <button
                      className="orange-disc"
                      type="button"
                      disabled={!runtime.connection.online || saving}
                      onClick={focusQuickAdd}
                      aria-label={settings.language === "en" ? "Focus quick add" : "输入任务"}
                    >
                      <Icon name="plus" />
                    </button>
                    <input
                      ref={quickInput}
                      value={quick}
                      onInput={() => quickRequest.current.edited()}
                      onChange={(event) => setQuick(event.target.value)}
                      onFocus={() => {
                        if (!pinned) pendingFocus.current = true;
                        setPinned(true);
                      }}
                      onKeyDown={(event) => {
                        if (
                          isCompositionKey(event.nativeEvent) &&
                          event.key === "Enter"
                        )
                          event.preventDefault();
                      }}
                      placeholder={
                        settings.language === "en"
                          ? "Add to today, Enter to create"
                          : "添加到今天，回车创建"
                      }
                      aria-label={
                        settings.language === "en"
                          ? "Quick add to today"
                          : "快速添加到今天"
                      }
                      disabled={!runtime.connection.online}
                    />
                    {saving ? <span className="quick-saving" role="status" aria-label={settings.language === "en" ? "Saving" : "正在保存"} />
                      : quick.trim() && <button type="submit" className="notch-quick-submit" disabled={!runtime.connection.online} aria-label={settings.language === "en" ? "Create task" : "创建任务"}><Icon name="up" size={12} /></button>}
                    </div>
                    <button
                      className="pill secondary notch-open-all"
                      type="button"
                      onClick={() => void openPanel()}
                    >
                      <span className="quiet-disc"><Icon name="open" size={10} /></span>
                      {settings.language === "en" ? "View all" : "查看全部"}
                    </button>
                  </form>
                </>
              ) : (
                <>
                  {cues.length > 1 && (
                    <div className="notch-stack-header">
                      <strong>{n(`${cues.length} 件在等你`, `${cues.length} waiting for you`)}</strong>
                      {deferredCount > 0 && (
                        <span className="notch-deferred">{n(`+${deferredCount} 条新提醒`, `+${deferredCount} new`)}</span>
                      )}
                      <span className="notch-stack-spacer" />
                      <button
                        className="notch-today-link"
                        onClick={openQuickLookFromStack}
                        aria-label={n("打开今天的快览", "Open today's quick look")}
                      >
                        {n("今天", "Today")} <Icon name="chevron" size={8} />
                      </button>
                      <button
                        className="icon-button"
                        onClick={() => closeQuickLook("fold-button")}
                        title={n("先收起，提醒仍留在刘海上", "Fold away; reminders stay on the notch")}
                        aria-label={n("先收起提醒，仍留在刘海上", "Fold reminders away; they stay on the notch")}
                      >
                        <Icon name="close" size={10} />
                      </button>
                    </div>
                  )}
                  <AnimatePresence initial={false}>
                    {stackCues.map((cue) => (
                      <CueCard
                        key={cue.key}
                        cue={cue}
                        featured={(featured && cue.key === featuredKey) || (cues.length === 1 && cueHovered)}
                        language={settings.language}
                        now={now}
                        arrivedAt={arrivals.current.get(cue.key) ?? cue.receivedAt}
                        disabled={!online || busyKeys.has(cue.key)}
                        completing={busyKeys.has(cue.key)}
                        onOpen={() =>
                          cue.task ? void revealTask(cue.task.id) : void openPanel()
                        }
                        onAnswer={(action) => void answer(cue, action)}
                        onFold={() => closeQuickLook("fold-button")}
                      />
                    ))}
                  </AnimatePresence>
                  {folding > 0 && (
                    <button
                      className="notch-fold-row"
                      onClick={openQuickLookFromStack}
                      aria-label={n(`还有 ${folding} 件提醒，在快览里查看`, `${folding} more reminders, see them in the quick look`)}
                    >
                      {n(`还有 ${folding} 件 · 在快览里查看`, `${folding} more · see in quick look`)} <Icon name="chevron" size={9} />
                    </button>
                  )}
                </>
              )}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </NotchSurface>
          )}
        </AnimatePresence>
      </div>
      {contextMenu.node}
    </motion.main>
  );
}

interface NotchToast {
  id: number;
  message: string;
  undo?: UndoAction;
}

/**
 * Exiting controls must leave the focus/AX tree before the native shell clips them. The stack
 * drops in from the top edge; the quick look settles in just behind the growing shell and
 * pulls back (scale and offset) before it leaves.
 */
function NotchSurface({ children, mode, bandHeight, reduced, onPin, onSecondaryPress, onPlainPress }: {
  children: ReactNode;
  mode: "stack" | "quick";
  bandHeight: number;
  reduced: boolean;
  onPin: (target: EventTarget) => void;
  /** A secondary press: the menu will pin, and remembers what the pin was before this press. */
  onSecondaryPress: () => void;
  /** Any other press or key: whatever a secondary press remembered no longer applies. */
  onPlainPress: () => void;
}) {
  const present = useIsPresent();
  const initial = reduced
    ? { opacity: 0 }
    : mode === "stack"
      ? { opacity: 0, y: -28, scale: 1 }
      : { opacity: 0, scale: 0.97, y: -8 };
  const exit = reduced
    ? { opacity: 0, transition: { duration: 0.12 } }
    : mode === "stack"
      ? { opacity: 0, y: -14, scale: 0.98, transition: { duration: 0.14, ease: "easeIn" as const } }
      : { opacity: 0, scale: 0.97, y: -8, transition: { duration: 0.12, delay: 0 } };
  return <motion.section
    className="notch-content"
    inert={!present}
    aria-hidden={!present}
    style={{ maxHeight: (mode === "stack" ? STACK_MAX_HEIGHT : QUICK_LOOK_MAX_HEIGHT) - bandHeight, transformOrigin: "top center", pointerEvents: present ? "auto" : "none" }}
    onPointerDownCapture={(event) => {
      // A secondary press opens the context menu, which pins the quick look only while it is up.
      const secondary = event.button === 2 || (platform === "macos" && event.ctrlKey);
      if (!present) return;
      if (secondary) onSecondaryPress();
      else {
        // A touch press may turn into a long press (a menu); a mouse press is just a press.
        if (event.pointerType === "touch" || event.pointerType === "pen") onSecondaryPress();
        else onPlainPress();
        onPin(event.target);
      }
    }}
    onKeyDownCapture={() => { if (present) onPlainPress(); }}
    onFocusCapture={(event) => { if (present) onPin(event.target); }}
    initial={initial}
    animate={{ opacity: 1, scale: 1, y: 0 }}
    exit={exit}
    transition={{ ...(reduced ? { duration: 0.12 } : motionTokens.settle), delay: reduced ? 0 : 0.06 }}
  >{children}</motion.section>;
}

/** The Cue disc: two rings leave it as the reminder lands, then the mark hops once and rests. */
function CueDisc({ arrivedAt, size, reduced }: { arrivedAt: number; size: number; reduced: boolean }) {
  const [elapsed, setElapsed] = useState(() => (Date.now() - arrivedAt) / 1000);
  useEffect(() => {
    if (reduced) { setElapsed(10); return; }
    let frame = 0;
    const tick = () => {
      const seconds = (Date.now() - arrivedAt) / 1000;
      setElapsed(seconds);
      if (seconds < 1.6) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [arrivedAt, reduced]);
  const pose = cuePose(elapsed, reduced);
  const rings = [0, 1].map((ring) => rippleProgress(elapsed - ring * 0.32, reduced));
  return (
    <span className="cue-disc" style={{ width: size + 2, height: size + 2 }} aria-hidden="true">
      {rings.map((p, index) => (
        <span
          key={index}
          className="cue-ring"
          style={{
            width: size,
            height: size,
            transform: `scale(${1 + 0.55 * p})`,
            opacity: p > 0 && p < 1 ? 0.55 * (1 - p) : 0,
          }}
        />
      ))}
      <span className="cue-disc-fill" style={{ width: size, height: size }}>
        <span
          className="cue-mark"
          style={{
            transform: `translateY(${pose.offsetY}px) rotate(${pose.rotation}deg) scale(${pose.scaleX * 1.1}, ${pose.scaleY * 1.1})`,
          }}
        >
          <Mark />
        </span>
      </span>
    </span>
  );
}

function CueCard({
  cue,
  featured,
  language,
  now,
  arrivedAt,
  disabled,
  completing,
  onOpen,
  onAnswer,
  onFold,
}: {
  cue: Cue;
  featured: boolean;
  language: string;
  now: number;
  arrivedAt: number;
  disabled: boolean;
  completing: boolean;
  onOpen: () => void;
  onAnswer: (action: "complete" | "snooze" | "pause_today") => void;
  onFold: () => void;
}) {
  const n = pick(language);
  const reduced = useReducedMotion();
  const meta = cueMeta(cue, now, language);
  const periodic = !!cue.periodic;
  const repeat = cue.repeats > 1 && (
    <span className="cue-repeat" aria-label={n(`已累计 ${cue.repeats} 次未完成`, `${cue.repeats} unanswered`)}>×{cue.repeats}</span>
  );
  const more = periodic && (
    <button
      className="icon-button cue-more"
      onClick={() => onAnswer("pause_today")}
      disabled={disabled}
      title={n("今天暂停", "Pause today")}
      aria-label={n("今天暂停", "Pause today")}
    >
      <Icon name="more" size={14} />
    </button>
  );
  return (
    <motion.article
      layout={!reduced}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={reduced ? { duration: 0.12 } : motionTokens.list}
      className={`cue-item ${featured ? "cue-card" : "cue-row"} ${completing ? "completing" : ""}`}
      data-cue-id={cue.id}
      role="group"
      aria-label={n(`TodoCue 提醒：${cue.title}`, `TodoCue reminder: ${cue.title}`)}
    >
      {featured ? (
        <>
          <div className="cue-card-head">
            <CueDisc arrivedAt={arrivedAt} size={46} reduced={!!reduced} />
            <div className="cue-card-text">
              <div className="cue-card-kicker">
                <span>{n("轻轻 Cue 你一下", "A little cue for you")}</span>
                {cue.late && <em>{n("· 刚才错过了", "· A little late")}</em>}
                {repeat}
              </div>
              <button className="cue-title" onClick={onOpen} aria-label={n(`打开提醒任务 ${cue.title}`, `Open ${cue.title}`)}>
                {cue.title}
              </button>
              <p className="cue-meta">{meta}</p>
            </div>
            <button
              className="icon-button cue-fold"
              onClick={onFold}
              title={n("先收起，提醒仍留在刘海上", "Fold away; reminders stay on the notch")}
              aria-label={n("先收起提醒，仍留在刘海上", "Fold reminders away; they stay on the notch")}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
          <div className="cue-actions">
            <button className="pill" onClick={() => onAnswer("complete")} disabled={disabled} aria-label={n("完成提醒任务", "Complete reminder")}>
              <span className="orange-disc"><Icon name="check" /></span>
              {periodic ? n("完成本次", "Done this time") : n("完成啦", "Done")}
            </button>
            <button className="pill secondary" onClick={() => onAnswer("snooze")} disabled={disabled} aria-label={n("Cue 提醒延后 10 分钟", "Snooze Cue for 10 minutes")}>
              <span className="quiet-disc"><Icon name="snooze" size={10} /></span>
              {n("10 分钟后", "In 10 minutes")}
            </button>
            {more}
            <span className="cue-actions-end">
              {completing ? <span className="quick-saving" role="status" /> : "TodoCue"}
            </span>
          </div>
        </>
      ) : (
        <div className="cue-row-line">
          <span className={`cue-glyph ${periodic ? "is-periodic" : ""}`} aria-hidden="true">
            {periodic ? <Mark /> : <Icon name="clock" size={13} />}
          </span>
          <button className="cue-title" onClick={onOpen} aria-label={n(`打开提醒任务 ${cue.title}`, `Open ${cue.title}`)}>
            <strong>{cue.title}</strong>
            <span className="cue-meta">{meta}</span>
          </button>
          {repeat}
          {more}
          {completing ? (
            <span className="quick-saving" role="status" />
          ) : (
            <>
              <button
                className="icon-button"
                onClick={() => onAnswer("snooze")}
                disabled={disabled}
                title={n("10 分钟后", "In 10 minutes")}
                aria-label={n("Cue 提醒延后 10 分钟", "Snooze Cue for 10 minutes")}
              >
                <Icon name="snooze" size={13} />
              </button>
              <button
                className="orange-disc cue-complete"
                onClick={() => onAnswer("complete")}
                disabled={disabled}
                aria-label={periodic ? n("完成本次", "Done this time") : n("完成提醒任务", "Complete reminder")}
              >
                <Icon name="check" size={12} />
              </button>
            </>
          )}
        </div>
      )}
    </motion.article>
  );
}
