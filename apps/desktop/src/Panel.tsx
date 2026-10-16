import { useReducedMotion } from "./useReducedMotion.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  type MotionValue,
} from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { CreateTaskInput, Task, UpdateTaskInput } from "@todocue/shared";
import { TodoCueError } from "@todocue/shared";
import {
  client,
  hidePanel,
  focusPanel,
  loadSettings,
  native,
  onPanelRevealed,
  saveSettings,
  startDrag,
  type DesktopSettings,
  defaults,
} from "./bridge.js";
import { translate } from "./i18n.js";
import { describeError, isNotFound, isVersionConflict } from "./errors.js";
import { isEditable, isPrimaryModifier, chord } from "./platform.js";
import { moveMessage, undoForShortcut, type NotifyInput, type UndoAction } from "./toast.js";
import { useToasts } from "./useToasts.js";
import { EmptyState, emptyCopy, NotFoundPage, OfflineBanner } from "./states.js";
import { SettingsPage } from "./SettingsPage.js";
import { Gauge, Mark, Numeral, TaskRow } from "./components.js";
import { Composer } from "./Composer.js";
import { useContextMenu, type MenuAnchor } from "./ContextMenu.js";
import { deleteConfirmText, taskMenuItems, type TaskMenuCommands } from "./taskMenu.js";
import { taskCommands } from "./taskCommands.js";
import { Detail } from "./Detail.js";
import { afterSave, composerDraft, newDraft, type TaskDraft } from "./drafts.js";
import { Icon } from "./icons.js";
import { TaskMetadata } from "./metadata.js";
import {
  CalendarPage,
  CompletedPage,
  PeriodicPage,
  PeriodicForm,
  type CalendarState,
  newPeriodicDraft,
  type PeriodicDraft,
} from "./pages.js";
import { projectGroups, useTaskDrag } from "./drag.js";
import { dayLabel, planDate, reschedule, rescheduleUndo, shiftDate } from "./dates.js";
import type { PeriodicReminder } from "@todocue/shared";
import { motionTokens, spring } from "./tokens.js";
import { HeaderSwap, TabSwap, VerticalSwap, tabDirection, useReveal, watchReveal } from "./motionKit.js";
import { useRuntime } from "./useRuntime.js";
import { ResizeEdge } from "./ResizeEdge.js";
import { isCompositionKey, QuickAddRequest } from "./quickAdd.js";

type Route =
  | "list"
  | "form"
  | "settings"
  | "detail"
  | "calendar"
  | "completed"
  | "periodic"
  | "periodicForm";

export function Panel() {
  const {
    board: liveBoard,
    rules,
    connection,
    error: runtimeError,
    revision: eventRevision,
    refresh,
  } = useRuntime();
  const [settings, setSettings] = useState<DesktopSettings>(defaults);
  const [view, setView] = useState<"today" | "upcoming" | "all">("today");
  const [route, setRoute] = useState<Route>("list");
  const history = useRef<
    { route: Route; task?: Task; periodic?: PeriodicReminder }[]
  >([]);
  const [pendingTarget, setPendingTarget] = useState<{
    kind: "task" | "periodic" | "open" | "new_task";
    id?: string;
  } | null>(null);
  const [formSession, setFormSession] = useState("");
  const activePage = useRef({ route, session: formSession });
  activePage.current = { route, session: formSession };
  const [calendarState, setCalendarState] = useState<CalendarState>({
    span: "month",
    anchor: new Date().toLocaleDateString("en-CA"),
    selected: new Date().toLocaleDateString("en-CA"),
    collapsed: false,
  });
  const [completedQuery, setCompletedQuery] = useState("");
  const [moving, setMoving] = useState(false);
  const listScroll = useRef<HTMLDivElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [periodicDraft, setPeriodicDraft] = useState<PeriodicDraft>(() =>
    newPeriodicDraft(),
  );
  const periodicDrafts = useRef(new Map<string, PeriodicDraft>());
  const [periodicSelected, setPeriodicSelected] = useState<
    PeriodicReminder | undefined
  >();
  const [quickDate, setQuickDate] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelPinned, setPanelPinned] = useState(false);
  const [quickFocused, setQuickFocused] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [quick, setQuick] = useState("");
  const [selected, setSelected] = useState<Task | undefined>();
  const [draft, setDraft] = useState<TaskDraft>(() => newDraft());
  const [finishing, setFinishing] = useState<Set<string>>(new Set());
  const finishingRef = useRef(new Set<string>());
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null);
  const contextMenu = useContextMenu();
  const deleteCancel = useRef<HTMLButtonElement>(null);
  // Deleting is permanent, so the safe answer is the one under the keyboard.
  useEffect(() => { if (pendingDelete) deleteCancel.current?.focus(); }, [pendingDelete]);
  const { toast, state: toastState, notify, dismiss, clearErrors } = useToasts();
  // Anything that used to set a sticky error line now raises an error toast; null clears it.
  const setError = useCallback(
    (message: string | null) => (message ? notify({ message, kind: "error" }) : clearErrors()),
    [notify, clearErrors],
  );
  const drafts = useRef(new Map<string, TaskDraft>());
  const quickRequest = useRef(new QuickAddRequest());
  const quickFocusRevision = useRef(0);
  const quickInput = useRef<HTMLInputElement>(null);
  const pendingQuickFocus = useRef(false);
  const [quickFocusTick, setQuickFocusTick] = useState(0);
  useLayoutEffect(() => {
    if (!pendingQuickFocus.current) return;
    pendingQuickFocus.current = false;
    if (route === "list" && !quickInput.current?.closest("[inert]")) quickInput.current?.focus();
  }, [route, quickFocusTick]);
  const t = translate(settings.language);
  // Each tab starts at its top, as it did when every tab had its own scroller.
  useEffect(() => {
    listScroll.current?.scrollTo({ top: 0 });
  }, [view]);
  const reduced = useReducedMotion();
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => watchReveal(() => setRevealTick((tick) => tick + 1), onPanelRevealed), []);
  const headerReveal = useReveal(0, revealTick, !!reduced);
  const nextReveal = useReveal(1, revealTick, !!reduced);
  const listReveal = useReveal(2, revealTick, !!reduced);
  const quickReveal = useReveal(3, revealTick, !!reduced);
  const pageReveal = useReveal(1, revealTick, !!reduced);
  // The lit dot's direction decides which side the new rows arrive from.
  const previousView = useRef(view);
  const viewDirection = tabDirection(previousView.current, view);
  useEffect(() => {
    previousView.current = view;
    document.querySelector(".list-scroll")?.scrollTo({ top: 0 });
  }, [view]);
  useEffect(() => {
    void loadSettings()
      .then(setSettings)
      .catch((error) => setError(String(error)));
  }, []);
  useEffect(() => {
    if (!native) return;
    let stopped = false;
    let dispose: (() => void) | undefined;
    void listen<DesktopSettings>("settings:changed", (event) =>
      setSettings(event.payload),
    ).then((stop) => {
      if (stopped) stop();
      else dispose = stop;
    });
    return () => {
      stopped = true;
      dispose?.();
    };
  }, []);
  const taskDrag = useTaskDrag({
    board: liveBoard,
    view,
    disabled:
      !connection.online || saving || !!search.trim() || route !== "list",
    onError: setError,
    commit: async (id, input) => {
      setMoving(true);
      try {
        const result = await client.moveTask(id, input, {
          idempotencyKey: crypto.randomUUID(),
        });
        announceMove(input, result.undoToken);
      } catch (error) {
        if (
          (error as { code?: string }).code === "DEADLINE_CONFIRMATION_REQUIRED"
        ) {
          setPendingMove({
            id,
            input,
            title: liveBoard?.all.find((task) => task.id === id)?.title ?? "",
          });
          return;
        }
        throw error;
      } finally {
        setMoving(false);
      }
      await refresh();
      await new Promise((resolve) => setTimeout(resolve, 220));
    },
  });
  const [pendingMove, setPendingMove] = useState<{
    id: string;
    input: import("@todocue/shared").MoveTaskInput;
    title: string;
  } | null>(null);
  function announceMove(
    input: import("@todocue/shared").MoveTaskInput,
    token?: string | null,
  ) {
    notify({
      message: moveMessage(
        input,
        settings.language,
        dayLabel(input.targetGroup, settings.language, liveBoard?.context.today),
      ),
      undo: token ? { kind: "order", token } : undefined,
    });
  }
  const board = taskDrag.frozen ?? liveBoard;
  const boardRef = useRef(board);
  boardRef.current = board;
  useEffect(() => {
    const reveal = (id: string) => setPendingTarget({ kind: "task", id });
    const handler = (event: Event) =>
      reveal((event as CustomEvent<string>).detail);
    window.addEventListener("todocue:reveal", handler);
    const routeHandler = (event: Event) =>
      setPendingTarget((event as CustomEvent).detail);
    window.addEventListener("todocue:route", routeHandler);
    let dispose: (() => void) | undefined,
      stopped = false;
    const revealRoute = (target: {
      kind: "task" | "periodic" | "open" | "new_task";
      id?: string;
    }) => setPendingTarget(target);
    if (native)
      void (async () => {
        const stops = await Promise.all([
          listen<string>("task:reveal", (event) => reveal(event.payload)),
          listen<{
            kind: "task" | "periodic" | "open" | "new_task";
            id?: string;
          }>("route:reveal", (event) => revealRoute(event.payload)),
        ]);
        if (stopped) {
          stops.forEach((stop) => stop());
          return;
        }
        dispose = () => stops.forEach((stop) => stop());
        const target = await invoke<{
          kind: "task" | "periodic" | "open" | "new_task";
          id?: string;
        } | null>("route_ready");
        if (target && !stopped) revealRoute(target);
      })().catch((error) => setError(String(error)));
    return () => {
      stopped = true;
      dispose?.();
      window.removeEventListener("todocue:reveal", handler);
      window.removeEventListener("todocue:route", routeHandler);
    };
  }, []);
  useEffect(() => {
    if (!pendingTarget || (!connection.online && pendingTarget.kind !== "new_task")) return;
    let stopped = false;
    void (async () => {
      if (pendingTarget.kind === "new_task") {
        edit(undefined, undefined, false, false);
      } else if (pendingTarget.kind === "task" && pendingTarget.id) {
        const { task } = await client.getTask(pendingTarget.id);
        if (!stopped) {
          history.current = [{ route: "list" }];
          setSelected(task);
          setRoute("detail");
        }
      } else if (pendingTarget.kind === "periodic" && pendingTarget.id) {
        const { reminder } = await client.getPeriodicReminder(pendingTarget.id);
        if (!stopped) {
          history.current = [{ route: "list" }];
          setPeriodicSelected(reminder);
          setRoute("periodic");
        }
      }
      if (!stopped) {
        setPendingTarget(null);
        setError(null);
      }
    })().catch((error) => {
      if (!stopped) {
        setError(String(error));
        if ((error as { code?: string }).code === "NOT_FOUND")
          setPendingTarget(null);
      }
    });
    return () => {
      stopped = true;
    };
  }, [pendingTarget, connection.online, eventRevision]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCompositionKey(event)) return;
      const primary = isPrimaryModifier(event);
      const key = event.key.toLowerCase();
      if (event.key === "Escape" || (primary && !event.shiftKey && key === "w")) {
        if (event.key !== "Escape") event.preventDefault();
        if (menuOpen) setMenuOpen(false);
        else if (pendingDelete) setPendingDelete(null);
        else if (pendingMove) setPendingMove(null);
        else if (route !== "list") back();
        else if (search) setSearch("");
        else if (!panelPinned) void hidePanel();
      }
      if (primary && event.shiftKey && key === "k") {
        event.preventDefault();
        navigate(route === "calendar" ? "list" : "calendar");
      }
      if (primary && !event.shiftKey && key === "z") {
        // A visible undo wins; inside a text field ⌘Z/Ctrl+Z stays the field's own undo.
        const action = undoForShortcut(toastState.current, isEditable(event.target));
        if (action) {
          event.preventDefault();
          void undoAction(action);
        }
      }
      if (primary && key === "n") {
        event.preventDefault();
        edit();
      }
      if (primary && key === "f") {
        event.preventDefault();
        void focusPanel().catch(error => setError(String(error)));
        pendingQuickFocus.current = true;
        setQuickFocusTick(value => value + 1);
        if (route !== "list") {
          navigate("list");
        }
      }
      if (primary && key === "r") {
        event.preventDefault();
        void refresh();
      }
      if (primary && event.key === ",") {
        event.preventDefault();
        navigate("settings");
      }
      if (primary && event.key === "[") {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    route,
    panelPinned,
    menuOpen,
    pendingDelete,
    search,
    quick,
    calendarState.selected,
    liveBoard?.context.today,
    selected?.id,
    settings.language,
    pendingMove,
    toast?.id,
  ]);
  // Native `<details>` menus stay open until toggled again; close them on an outside press or a choice.
  useEffect(() => {
    const close = (event: Event) => {
      const target = event.target as Element | null;
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.action-menu[open]")) {
        if (!menu.contains(target)) menu.open = false;
        else if (event.type === "click" && target?.closest(".action-menu > div button")) menu.open = false;
      }
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("click", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("click", close, true);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);
  useEffect(() => {
    // Offline already has its own banner with a retry button; only report failures while connected.
    if (runtimeError && connection.online) notify({ message: runtimeError, kind: "error" });
  }, [runtimeError, connection.online, notify]);
  function navigate(next: Route) {
    if (next !== route)
      history.current.push({
        route,
        task: selected,
        periodic: periodicSelected,
      });
    setRoute(next);
    setMenuOpen(false);
    setError(null);
  }
  function back() {
    const previous = history.current.pop();
    setRoute(previous?.route ?? "list");
    setSelected(previous?.task);
    setPeriodicSelected(previous?.periodic);
    setError(null);
    setConflict(false);
  }
  function openTask(task: Task) {
    navigate("detail");
    setSelected(task);
  }
  useEffect(() => {
    if (!selected || route === "form" || !connection.online) return;
    let stopped = false;
    const live =
      liveBoard?.all.find((task) => task.id === selected.id) ??
      liveBoard?.today.completed.find((task) => task.id === selected.id);
    if (live && live.version >= selected.version) {
      if (live.version > selected.version) setSelected(live);
    } else
      void client
        .getTask(selected.id)
        .then(({ task }) => {
          if (!stopped)
            setSelected((current) =>
              current?.id === task.id && current.version <= task.version
                ? task
                : current,
            );
        })
        .catch((error) => {
          // Deleted elsewhere while its page was open: leave the page and drop its draft.
          if (stopped || !isNotFound(error)) return;
          drafts.current.delete(selected.id);
          if (activePage.current.route === "detail") {
            notify({ message: settings.language === "en" ? "That task was deleted" : "这个任务已被删除" });
            back();
          }
        });
    return () => {
      stopped = true;
    };
  }, [eventRevision, liveBoard, selected?.id, route, connection.online]);
  function edit(task?: Task, title?: string, fromQuickAdd = false, focus = true) {
    if (focus) void focusPanel().catch(error => setError(String(error)));
    navigate("form");
    setFormSession(crypto.randomUUID());
    setSelected(task);
    const date = (route === "calendar" ? calendarState.selected : board?.context.today) ?? new Date().toISOString().slice(0, 10);
    setDraft(task ? drafts.current.get(task.id) ?? newDraft(task, date)
      : composerDraft(drafts.current.get("new"), date, title, fromQuickAdd, route === "calendar"));
    if (fromQuickAdd && title?.trim()) { setQuick(""); quickRequest.current.edited(); }
    setConflict(false);
    setError(null);
  }
  function editPeriodic(rule?: PeriodicReminder) {
    void focusPanel().catch(error => setError(String(error)));
    navigate("periodicForm");
    setFormSession(crypto.randomUUID());
    setPeriodicSelected(rule);
    setPeriodicDraft(
      periodicDrafts.current.get(rule?.id ?? "new") ??
        newPeriodicDraft(rule, settings.language),
    );
  }
  /** One place that turns a failed write into a toast; a version conflict also refreshes the board. */
  function fail(error: unknown) {
    notify({ message: describeError(error, settings.language), kind: "error" });
    if (isVersionConflict(error)) {
      setConflict(true);
      void refresh();
    }
  }
  async function run(action: () => Promise<unknown>) {
    if (!connection.online || saving) return false;
    setSaving(true);
    setError(null);
    try {
      await action();
      await refresh();
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function undoAction(action: UndoAction) {
    dismiss();
    await run(async () => {
      if (action.kind === "reopen")
        await client.reopenTask(action.taskId, { expectedVersion: action.version });
      else if (action.kind === "order")
        await client.undoOrder({
          token: action.token,
          expectedRevision: boardRef.current!.ordering.revision,
        });
      else
        await client.updateTask(action.taskId, {
          expectedVersion: action.expectedVersion,
          scheduledDate: action.scheduledDate,
          scheduledAt: action.scheduledAt,
          ...("dueDate" in action ? { dueDate: action.dueDate, dueAt: action.dueAt } : {}),
          ...(action.scheduledAt || action.dueAt ? { timezone: action.timezone } : {}),
        });
    });
  }
  const listTasks = (view === "upcoming" ? board?.upcoming : board?.all) ?? [];
  const matching = listTasks.filter(
    (task) =>
      !search.trim() ||
      [task.title, task.project ?? "", task.notes ?? ""].some((value) =>
        value.toLowerCase().includes(search.trim().toLowerCase()),
      ),
  );
  const groupKeys = [
    ...new Set(
      matching.map((task) =>
        view === "all" ? (task.project ?? "") : (planDate(task) ?? ""),
      ),
    ),
  ].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  if (
    view === "all" &&
    !search.trim() &&
    matching.length > 0 &&
    !groupKeys.includes("")
  )
    groupKeys.push("");
  const groups = projectGroups(
    view === "today"
      ? ["overdue", "must", "scheduled"].map((section) => ({
          key: `${board?.context.today}:${section}`,
          label: t(section as "overdue" | "must" | "scheduled"),
          tasks:
            board?.today.items
              .filter((item) => item.section === section)
              .map((item) => item.task) ?? [],
        }))
      : groupKeys.map((key) => ({
          key,
          label:
            view === "all"
              ? key || t("ungrouped")
              : dayLabel(key, settings.language, board?.context.today),
          tasks: matching.filter(
            (task) =>
              (view === "all"
                ? (task.project ?? "")
                : (planDate(task) ?? "")) === key,
          ),
        })),
    taskDrag.drag,
  );
  const count =
    view === "today" ? (board?.today.items.length ?? 0) : listTasks.length;
  const visibleCount = groups.reduce((n, group) => n + group.tasks.length, 0);
  const completed = board?.today.completed.length ?? 0;
  const next = board?.next.next?.task;
  const addDate =
    route === "calendar" ? calendarState.selected : board?.context.today;
  async function complete(task: Task, feedbackDone = false) {
    if (!connection.online || saving || finishingRef.current.has(task.id))
      return false;
    setError(null);
    finishingRef.current.add(task.id);
    setFinishing(new Set(finishingRef.current));
    if (!feedbackDone)
      await new Promise((resolve) => setTimeout(resolve, reduced ? 120 : 420));
    try {
      const result = await (task.status === "done"
        ? client.reopenTask(task.id, { expectedVersion: task.version })
        : client.completeTask(task.id, { expectedVersion: task.version }));
      if (task.status !== "done")
        notify({
          message: settings.language === "en" ? `Completed “${result.task.title}”` : `已完成「${result.task.title}」`,
          undo: { kind: "reopen", taskId: result.task.id, version: result.task.version },
        });
      if (selected?.id === task.id) setSelected(result.task);
      await refresh();
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      finishingRef.current.delete(task.id);
      setFinishing(new Set(finishingRef.current));
    }
  }
  // The row menu. Every command looks the task up again, so a menu that stayed open while the
  // board refreshed still writes against the current version.
  const latestTask = (task: Task) =>
    liveBoard?.all.find((item) => item.id === task.id) ??
    liveBoard?.today.completed.find((item) => item.id === task.id) ??
    task;
  const planToday = liveBoard?.context.today ?? calendarState.anchor;
  const menuCommands: TaskMenuCommands = {
    complete: (task) => void complete(latestTask(task), false),
    reopen: (task) => void run(() => taskCommands.reopen(latestTask(task))),
    snooze: (task) =>
      void run(async () => {
        await taskCommands.snooze(latestTask(task));
        notify({ message: settings.language === "en" ? "Reminding you in 10 minutes" : "将在 10 分钟后提醒" });
      }),
    tomorrow: (task) =>
      void run(async () => {
        const before = latestTask(task);
        const { task: after } = await taskCommands.tomorrow(before, planToday);
        notify({
          message: settings.language === "en" ? "Moved to tomorrow" : "已改期到明天",
          undo: rescheduleUndo(before, after),
        });
      }),
    edit: (task) => edit(latestTask(task)),
    cancel: (task) => void run(() => taskCommands.cancel(latestTask(task))),
    skip: (task) => void run(() => taskCommands.skip(latestTask(task))),
    requestDelete: (task) => setPendingDelete(latestTask(task)),
  };
  function openTaskMenu(task: Task, anchor: MenuAnchor) {
    contextMenu.open(
      anchor,
      taskMenuItems(task, {
        language: settings.language,
        online: connection.online,
        busy: saving || finishingRef.current.has(task.id),
        commands: menuCommands,
      }),
      task.title,
    );
  }
  // A menu belongs to the page it was opened on, and its items were built for one connection state.
  useEffect(() => contextMenu.close(), [route, connection.online]);
  async function confirmDelete(task: Task) {
    await run(async () => {
      await taskCommands.remove(latestTask(task));
      setPendingDelete(null);
      notify({
        message: settings.language === "en" ? `Deleted “${task.title}”` : `已删除「${task.title}」`,
      });
      if (route === "detail" && selected?.id === task.id) back();
    });
  }
  return (
    <main className="panel-shell"
      onPointerDownCapture={(event) => {
        if (native && navigator.userAgent.includes("Windows") &&
          (event.target as Element).closest("input, textarea, button, select, summary, [contenteditable=true]"))
          void focusPanel().catch(error => setError(String(error)));
        if (event.target instanceof Element && !event.target.closest(".quick-row")) quickFocusRevision.current++;
      }}
      onFocusCapture={(event) => {
        if (event.target instanceof Element && !event.target.closest(".quick-row")) quickFocusRevision.current++;
      }}
    >
      {native && (
        <>
          <ResizeEdge
            direction="West"
            label={
              settings.language === "en" ? "Resize panel width" : "面板宽度"
            }
            onError={setError}
            onReset={() => {
              const next = { ...settings, width: 340 };
              setSettings(next);
              void saveSettings(next).catch((error) => setError(String(error)));
            }}
          />
          <ResizeEdge
            direction="South"
            label={
              settings.language === "en" ? "Resize panel height" : "面板高度"
            }
            onError={setError}
            onReset={() => {
              const next = { ...settings, height: 680 };
              setSettings(next);
              void saveSettings(next).catch((error) => setError(String(error)));
            }}
          />
        </>
      )}

      {taskDrag.drag && (
        <div
          aria-hidden="true"
          inert
          className={`drag-card graphite ${taskDrag.drag.landing ? "landing" : ""}`}
          style={{
            position: "fixed",
            left: taskDrag.drag.x,
            top: taskDrag.drag.y,
            width: taskDrag.drag.width,
            pointerEvents: "none",
            zIndex: 40,
            transform: taskDrag.drag.landing
              ? `translate(${taskDrag.drag.landing.x - taskDrag.drag.x}px, ${taskDrag.drag.landing.y - taskDrag.drag.y}px)`
              : undefined,
          }}
        >
          <TaskRow
            task={taskDrag.drag.task}
            disabled={false}
            onOpen={() => {}}
            onComplete={async () => {}}
          />
        </div>
      )}
      {pendingDelete && (
        <div className="confirmation frost" role="alertdialog" aria-label={deleteConfirmText(settings.language).title}>
          <h3>{deleteConfirmText(settings.language).title}</h3>
          <p>{deleteConfirmText(settings.language).body}</p>
          <button
            className="pill danger"
            disabled={!connection.online || saving}
            onClick={() => void confirmDelete(pendingDelete)}
          >
            {deleteConfirmText(settings.language).confirm}
          </button>
          <button className="text-button" ref={deleteCancel} onClick={() => setPendingDelete(null)}>
            {deleteConfirmText(settings.language).cancel}
          </button>
        </div>
      )}
      {pendingMove && (
        <div className="confirmation frost" role="alertdialog">
          <h3>
            {settings.language === "en"
              ? "Plan is past the deadline"
              : "计划晚于截止时间"}
          </h3>
          <p>
            {settings.language === "en"
              ? `Moving “${pendingMove.title}” to ${dayLabel(pendingMove.input.targetGroup, settings.language, board?.context.today)} lands after its deadline. The deadline and reminder keep their values.`
              : `将「${pendingMove.title}」改期到 ${dayLabel(pendingMove.input.targetGroup, settings.language, board?.context.today)}，会晚于原截止时间。截止日期和提醒时间将保持原值。`}
          </p>
          <button
            className="pill"
            onClick={() =>
              void run(async () => {
                const result = await client.moveTask(
                  pendingMove.id,
                  { ...pendingMove.input, allowPastDeadline: true },
                  { idempotencyKey: crypto.randomUUID() },
                );
                announceMove(pendingMove.input, result.undoToken);
                setPendingMove(null);
              })
            }
          >
            {settings.language === "en"
              ? "Reschedule and keep deadline"
              : "保留截止日期并改期"}
          </button>
          <button className="text-button" onClick={() => setPendingMove(null)}>
            {settings.language === "en" ? "Cancel" : "取消"}
          </button>
        </div>
      )}
      <motion.header className="tile graphite panel-header" data-route={route} style={headerReveal}>
        <div className="brand">
          {route === "list" ? (
            <Mark />
          ) : (
            <button
              className="icon-button back-button"
              onClick={back}
              aria-label={t("cancel")}
              title={`${t("cancel")} (${chord("[")})`}
            >
              <Icon name="back" />
            </button>
          )}
          <span>TodoCue</span>
          <div
            className="drag-zone"
            onPointerDown={(event) => {
              if (event.button === 0) void startDrag();
            }}
            aria-hidden="true"
          />
          {route === "list" && (
            <button
              className="icon-button"
              onClick={() => {
                setQuickDate(board?.context.today);
                navigate("calendar");
              }}
              aria-label={
                settings.language === "en" ? "Open calendar" : "打开日历"
              }
              title={`${settings.language === "en" ? "Open calendar" : "打开日历"} (${chord("⇧K")})`}
            >
              <Icon name="calendar" />
            </button>
          )}
          <button
            className={`icon-button ${panelPinned ? "is-pinned" : ""}`}
            onClick={() => setPanelPinned((value) => !value)}
            aria-label={settings.language === "en" ? "Pin panel" : "固定面板"}
            aria-pressed={panelPinned}
            title={
              panelPinned
                ? settings.language === "en" ? "Unpin (allow Esc to hide)" : "取消固定（允许 Esc 收起）"
                : settings.language === "en" ? "Pin the panel so Esc doesn’t hide it" : "固定面板，防止 Esc 误收起"
            }
          >
            <Icon name="pin" />
          </button>
          <button
            className="icon-button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-expanded={menuOpen}
            aria-label={
              settings.language === "en" ? "More actions" : "更多操作"
            }
            title={settings.language === "en" ? "More actions" : "更多操作"}
          >
            <Icon name="more" />
          </button>
          <button
            className="icon-button"
            onClick={() => void hidePanel()}
            aria-label={t("hide")}
            title={settings.language === "en" ? "Hide the panel; tasks and reminders keep running" : "收起面板，任务与提醒继续运行"}
          >
            <Icon name="close" />
          </button>
        </div>
        <AnimatePresence initial={false} mode="popLayout">
        {route === "list" ? (
          <HeaderSwap key="list" reduced={!!reduced}>
            <nav className="tabs" aria-label="任务视图切换">
              <div className="tab-dots">
                {(["today", "upcoming", "all"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setView(tab)}
                    aria-label={t(tab)}
                    aria-current={view === tab ? "page" : undefined}
                  >
                    <span className="dot-ring" />
                    {view === tab && (
                      <motion.span
                        className="dot-active"
                        layoutId={reduced ? undefined : "selected-view"}
                        transition={motionTokens.snap}
                      />
                    )}
                    <span className="dot-center" />
                  </button>
                ))}
              </div>
              <div className="tab-labels">
                {(["today", "upcoming", "all"] as const).map((tab, i) => (
                  <span key={tab}>
                    {i > 0 && <span className="tab-separator">·</span>}
                    <button
                      onClick={() => setView(tab)}
                      className={view === tab ? "selected" : ""}
                      aria-hidden="true"
                      tabIndex={-1}
                    >
                      {t(tab)}
                    </button>
                  </span>
                ))}
              </div>
            </nav>
            <div className="instrument">
              <Numeral value={count} />
              <div className="instrument-caption">
                <strong>
                  {settings.language === "en"
                    ? view === "upcoming"
                      ? "upcoming"
                      : "to-dos"
                    : view === "upcoming"
                      ? "件即将到来"
                      : "件待办"}
                </strong>
                <time>
                  {view === "today"
                    ? `${board ? new Intl.DateTimeFormat(settings.language, { month: "long", day: "numeric", weekday: "short", timeZone: board.context.timezone }).format(new Date(board.context.now)) : "—"} · ${t("completed")} ${completed}`
                    : settings.language === "en"
                      ? view === "all"
                        ? "Organized by project"
                        : "Ordered by planned date"
                      : view === "all"
                        ? "按项目整理"
                        : "按计划日期排列"}
                </time>
              </div>
            </div>
          </HeaderSwap>
        ) : (
          route !== "detail" && (
            <HeaderSwap key={route} reduced={!!reduced}>
            <h1 className="page-heading">
              {route === "settings"
                ? settings.language === "en"
                  ? "Preferences"
                  : "偏好设置"
                : route === "calendar"
                  ? settings.language === "en"
                    ? "Calendar"
                    : "日历"
                  : route === "completed"
                    ? t("completed")
                    : route === "periodic"
                      ? settings.language === "en"
                        ? "Periodic reminders"
                        : "周期提醒"
                      : route === "periodicForm"
                        ? periodicDraft.original
                          ? settings.language === "en"
                            ? "Edit periodic reminder"
                            : "编辑周期提醒"
                          : t("addReminder")
                        : selected
                          ? t("edit")
                          : settings.language === "en"
                            ? "A little thing to remember"
                            : "记下一件事"}
            </h1>
            </HeaderSwap>
          )
        )}
        </AnimatePresence>
        {!connection.online && (
          <OfflineBanner
            language={settings.language}
            message={connection.message}
            retrying={retrying}
            onRetry={() => {
              setRetrying(true);
              void refresh().finally(() => setRetrying(false));
            }}
          />
        )}
      </motion.header>
      {menuOpen && (
        <div
          className="header-menu graphite"
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            disabled={!connection.online}
            onClick={() => {
              edit();
              setMenuOpen(false);
            }}
          >
            <Icon name="plus" />
            {t("newTask")}
          </button>
          <button
            disabled={!connection.online}
            onClick={() => {
              editPeriodic();
              setMenuOpen(false);
            }}
          >
            <Icon name="clock" />
            {t("addReminder")}
          </button>
          <button
            onClick={() => {
              navigate("periodic");
              setMenuOpen(false);
            }}
          >
            <Icon name="repeat" />
            {settings.language === "en" ? "Periodic reminders…" : "周期提醒…"}
          </button>
          <button
            onClick={() => {
              navigate("completed");
              setMenuOpen(false);
            }}
          >
            <Icon name="check" />
            {t("completed")}…
          </button>
          <button
            onClick={() => {
              navigate("settings");
              setMenuOpen(false);
            }}
          >
            <Icon name="settings" />
            {t("settings")}
          </button>
          <button
            onClick={() => {
              void refresh();
              setMenuOpen(false);
            }}
          >
            <Icon name="repeat" />
            {settings.language === "en" ? "Refresh" : "刷新"}
          </button>
          <button
            onClick={() => {
              void client.export().then((bundle) => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(bundle, null, 2)], {
                    type: "application/json",
                  }),
                );
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "todocue.json";
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              });
              setMenuOpen(false);
            }}
          >
            ↓ {settings.language === "en" ? "Export JSON" : "导出 JSON"}
          </button>
        </div>
      )}
      <div className="page-stage">
        <AnimatePresence initial={false}>
          <RouteSurface
            key={route}
            reduced={!!reduced}
            depth={history.current.length}
            reveal={route === "list" ? undefined : pageReveal}
          >
            {(route === "list" || route === "calendar") && (
              <>
                {route === "calendar" && (
                  <CalendarPage
                    language={settings.language}
                    online={connection.online}
                    eventRevision={eventRevision}
                    state={calendarState}
                    setState={setCalendarState}
                    activeTasks={board?.all ?? []}
                    today={
                      board?.context.today ??
                      new Date().toISOString().slice(0, 10)
                    }
                    onQuickDate={setQuickDate}
                    onNotify={notify}
                    onOpen={openTask}
                    onMenu={openTaskMenu}
                    onComplete={async (task) => {
                      return complete(task, true);
                    }}
                    onError={setError}
                  />
                )}
                {route === "list" && (
                  <motion.div layoutScroll className="list-scroll" ref={listScroll}>
                    {moving && (
                      <div className="list-hint" role="status">
                        {settings.language === "en" ? "Saving the move…" : "正在保存移动…"}
                      </div>
                    )}
                    <AnimatePresence initial={false} mode="popLayout">
                    {view === "today" && next && (
                      <motion.section
                        key="next-card"
                        className="tile frost next-card"
                        style={{ x: nextReveal.x, originY: 0 }}
                        initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
                        transition={reduced ? { duration: 0.12 } : motionTokens.list}
                      >
                        <div className="next-heading">
                          <span className="eyebrow">NEXT</span>
                          <span>{t("next")}</span>
                          <span className="next-reason">
                            {board?.next.next?.group === "overdue"
                              ? t("overdue")
                              : board?.next.next?.group === "due_today"
                                ? t("must")
                                : board?.next.next?.group ===
                                    "scheduled_reached"
                                  ? settings.language === "en"
                                    ? "Planned time reached"
                                    : "已到计划时间"
                                  : settings.language === "en"
                                    ? "Unscheduled"
                                    : "未安排"}
                          </span>
                        </div>
                        <div className="next-body">
                          <div className="next-swap">
                          <AnimatePresence initial={false} mode="popLayout">
                          <VerticalSwap key={next.id} reduced={!!reduced}>
                            <button
                              className={`next-title ${finishing.has(next.id) ? "finishing-title" : ""}`}
                              onClick={() => openTask(next)}
                            >
                              {next.title}
                            </button>
                            <TaskMetadata
                              task={next}
                              language={settings.language}
                              today={board?.context.today}
                            />
                            <div className="next-actions">
                              <button
                                className="pill"
                                disabled={
                                  !connection.online ||
                                  saving ||
                                  finishing.has(next.id)
                                }
                                onClick={() => void complete(next)}
                              >
                                <span className="orange-disc">
                                  <Icon name="check" />
                                </span>
                                {t("complete")}
                              </button>
                              <button
                                className="icon-button"
                                onClick={() => openTask(next)}
                                aria-label={t("details")}
                              >
                                <Icon name="open" />
                              </button>
                            </div>
                          </VerticalSwap>
                          </AnimatePresence>
                          </div>
                          <Gauge
                            completed={completed}
                            total={count + completed}
                          />
                        </div>
                      </motion.section>
                    )}
                    </AnimatePresence>
                    <motion.section
                      layout="position"
                      transition={reduced ? { duration: 0.12 } : motionTokens.list}
                      style={listReveal}
                      className="tile graphite task-list"
                      aria-label={t(view)}
                    >
                      {view === "all" && (
                        <div className="search-field">
                          <Icon name="search" />
                          <input
                            aria-label={
                              settings.language === "en"
                                ? "Search tasks"
                                : "搜索任务"
                            }
                            placeholder={
                              settings.language === "en"
                                ? "Search tasks, projects or notes"
                                : "搜索任务、项目或备注"
                            }
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                          />
                          {search && (
                            <button
                              type="button"
                              className="search-clear"
                              aria-label={settings.language === "en" ? "Clear search" : "清除搜索"}
                              title={settings.language === "en" ? "Clear search" : "清除搜索"}
                              onClick={() => setSearch("")}
                            >
                              <Icon name="close" size={10} />
                            </button>
                          )}
                        </div>
                      )}
                      <AnimatePresence initial={false} mode="popLayout">
                      <TabSwap key={view} direction={viewDirection} reduced={!!reduced}>
                      {view === "all" && search.trim() && (
                        <p className="search-hint">
                          {settings.language === "en"
                            ? "Clear the search to reorder by dragging"
                            : "清除搜索后可拖动调整顺序"}
                        </p>
                      )}
                      {!board && connection.online ? (
                        <div className="skeleton" />
                      ) : visibleCount === 0 && !(view === "today" && next) ? (
                        !board ? (
                          <EmptyState
                            icon="clock"
                            title={settings.language === "en" ? "Tasks show up here once connected" : "连接后，任务会显示在这里"}
                          />
                        ) : (
                          <EmptyState {...emptyCopy(view, !!search.trim(), completed, settings.language)}
                            onAction={view !== "upcoming" && !search.trim() ? () => quickInput.current?.focus() : undefined}
                          />
                        )
                      ) : (
                        groups
                          .filter(
                            (group) => group.tasks.length || view === "all",
                          )
                          .map((group) => (
                            <section key={group.key}>
                              {group.label && (
                                <h3
                                  data-drop-group={group.key}
                                  data-before-id={group.tasks[0]?.id ?? ""}
                                >
                                  {group.label}
                                  <span>{group.tasks.length}</span>
                                  {board?.ordering.groups.some(
                                    (order) =>
                                      order.view === view &&
                                      order.group === group.key &&
                                      order.taskIds.length > 0,
                                  ) && (
                                    <button
                                      className="group-reset"
                                      disabled={
                                        !connection.online ||
                                        saving ||
                                        !!taskDrag.drag
                                      }
                                      onClick={() =>
                                        void run(async () => {
                                          const result =
                                            await client.resetOrder({
                                              view,
                                              group: group.key,
                                              expectedRevision:
                                                board!.ordering.revision,
                                            });
                                          notify({
                                            message: settings.language === "en" ? "Order updated" : "已恢复自动排序",
                                            undo: { kind: "order", token: result.undoToken },
                                          });
                                        })
                                      }
                                      aria-label={
                                        settings.language === "en"
                                          ? `Restore automatic order in ${group.label}`
                                          : `${group.label}恢复自动排序`
                                      }
                                      title={settings.language === "en" ? "Manual order · restore automatic" : "手动排序 · 恢复自动排序"}
                                    >
                                      <Icon name="repeat" size={10} />
                                    </button>
                                  )}
                                </h3>
                              )}
                              <AnimatePresence initial={false} mode="popLayout">
                                {group.tasks.map((task) => (
                                  <TaskRow
                                    group={group.key}
                                    dragging={
                                      taskDrag.drag?.task.id === task.id
                                    }
                                    showProject={view !== "all"}
                                    today={board?.context.today}
                                    onDrag={(task, event) =>
                                      taskDrag.begin(task, group.key, event)
                                    }
                                    key={task.id}
                                    task={task}
                                    disabled={!connection.online || saving}
                                    completingExternal={finishing.has(task.id)}
                                    onComplete={async (task) => {
                                      return complete(task, true);
                                    }}
                                    onOpen={openTask}
                                    onMenu={openTaskMenu}
                                  />
                                ))}
                              </AnimatePresence>
                              <div
                                className="group-end"
                                data-drop-group={group.key}
                                data-before-id=""
                              />
                            </section>
                          ))
                      )}
                      {view === "today" && completed > 0 && (
                        <div className="completed-today">
                          <div className="completed-today-heading">
                            <button
                              aria-expanded={completedExpanded}
                              aria-label={
                                settings.language === "en"
                                  ? `${completedExpanded ? "Collapse" : "Expand"} completed today`
                                  : `${completedExpanded ? "收起" : "展开"}今日已完成`
                              }
                              onClick={() =>
                                setCompletedExpanded((value) => !value)
                              }
                            >
                              <Icon
                                name="chevron"
                                size={10}
                                style={{
                                  transform: completedExpanded
                                    ? "rotate(90deg)"
                                    : undefined,
                                }}
                              />
                              {settings.language === "en"
                                ? "Completed today"
                                : "今日已完成"}{" "}
                              {completed}
                            </button>
                            <button onClick={() => navigate("completed")}>
                              {settings.language === "en"
                                ? "View all"
                                : "查看全部"}
                            </button>
                          </div>
                          <AnimatePresence initial={false} mode="popLayout">
                          {completedExpanded &&
                            board?.today.completed.map((task) => (
                              <TaskRow
                                key={task.id}
                                task={task}
                                today={board.context.today}
                                disabled={!connection.online || saving}
                                onOpen={openTask}
                                onMenu={openTaskMenu}
                                onComplete={(task) => complete(task, true)}
                              />
                            ))}
                          </AnimatePresence>
                        </div>
                      )}
                      </TabSwap>
                      </AnimatePresence>
                    </motion.section>
                  </motion.div>
                )}
                <motion.form
                  style={route === "list" ? quickReveal : undefined}
                  className="tile frost quick-add"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!quick.trim() || saving || !connection.online) return;
                    const submitter = (event.nativeEvent as SubmitEvent).submitter;
                    const focusRevision = quickFocusRevision.current;
                    const ownsFocus = document.activeElement === quickInput.current ||
                      document.activeElement === submitter || (!!submitter && document.activeElement === document.body);
                    const title = quick,
                      payload = { title, scheduledDate: addDate };
                    const operation = quickRequest.current.begin(payload);
                    if (!operation) return;
                    // Disabling the submit button can move focus to BODY before the response.
                    if (ownsFocus) quickInput.current?.focus();
                    void run(async () => {
                      try {
                        const created = await client.createTask(payload, { idempotencyKey: operation.key });
                        notify({
                          message: settings.language === "en" ? `Added “${created.task.title}”` : `已添加「${created.task.title}」`,
                        });
                        const restoreFocus = ownsFocus && activePage.current.route === route && quickFocusRevision.current === focusRevision && (
                          document.activeElement === quickInput.current || document.activeElement === submitter ||
                          document.activeElement === document.body
                        );
                        if (quickRequest.current.commit(operation)) setQuick("");
                        if (restoreFocus) requestAnimationFrame(() => {
                          if (activePage.current.route === route && quickFocusRevision.current === focusRevision)
                            quickInput.current?.focus();
                        });
                      } finally { quickRequest.current.settle(); }
                    });
                  }}
                >
                  <div className="quick-row">
                    <motion.button
                      className={`quick-disc ${quickFocused || quick.trim() ? "focused" : ""}`}
                      type={quick.trim() ? "submit" : "button"}
                      onClick={() => {
                        if (!quick.trim()) quickInput.current?.focus();
                      }}
                      disabled={!connection.online || saving}
                      aria-label={t("save")}
                      whileTap={reduced ? undefined : { scale: 0.9 }}
                    >
                      <AnimatePresence mode="popLayout" initial={false}>
                        <motion.span
                          key={quick.trim() ? "send" : "plus"}
                          initial={{ opacity: 0, scale: reduced ? 1 : 0.4 }}
                          animate={{
                            opacity: 1,
                            scale: 1,
                            rotate:
                              !quick.trim() && quickFocused && !reduced
                                ? 90
                                : 0,
                          }}
                          exit={{ opacity: 0, scale: reduced ? 1 : 0.4 }}
                          transition={reduced ? { duration: 0.12 } : motionTokens.snap}
                        >
                          <Icon name={quick.trim() ? "up" : "plus"} size={20} />
                        </motion.span>
                      </AnimatePresence>
                    </motion.button>
                    <input
                      ref={quickInput}
                      value={quick}
                      onFocus={() => setQuickFocused(true)}
                      onBlur={() => setQuickFocused(false)}
                      onInput={() => quickRequest.current.edited()}
                      onChange={(event) => setQuick(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          isCompositionKey(event.nativeEvent) &&
                          event.key === "Enter"
                        )
                          event.preventDefault();
                      }}
                      placeholder={
                        addDate && addDate !== board?.context.today
                          ? `${settings.language === "en" ? "Add to" : "添加到"} ${dayLabel(addDate!, settings.language)}…`
                          : settings.language === "en"
                            ? "Add to today…"
                            : "添加到今天…"
                      }
                      aria-label={
                        settings.language === "en"
                          ? "Quick add to today"
                          : "快速添加到今天"
                      }
                      disabled={!connection.online}
                    />
                    {!quick.trim() && (
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => edit(undefined, quick, true)}
                        aria-label={t("details")}
                      >
                        <Icon name="edit" />
                      </button>
                    )}
                  </div>
                  <AnimatePresence>
                    {(quickFocused || quick.trim()) && (
                      <motion.div
                        className="quick-details"
                        initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                        transition={reduced ? { duration: 0.12 } : motionTokens.snap}
                      >
                        <span>
                          <Icon name="calendar" size={12} />
                          {addDate
                            ? dayLabel(
                                addDate,
                                settings.language,
                                board?.context.today,
                              )
                            : t("today")}
                        </span>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => edit(undefined, quick, true)}
                        >
                          {t("details")}
                        </button>
                        <span>↵</span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.form>
              </>
            )}
            {route === "completed" && (
              <CompletedPage
                language={settings.language}
                online={connection.online}
                eventRevision={eventRevision}
                today={board?.context.today}
                timezone={board?.context.timezone}
                query={completedQuery}
                onQuery={setCompletedQuery}
                onOpen={openTask}
                onMenu={openTaskMenu}
                onComplete={async (task) => {
                  return complete(task, true);
                }}
                onError={setError}
              />
            )}
            {route === "periodic" && (
              <PeriodicPage
                language={settings.language}
                online={connection.online}
                rules={rules}
                selectedId={periodicSelected?.id}
                loadError={runtimeError}
                onError={setError}
                onChanged={refresh}
                onEdit={editPeriodic}
              />
            )}
            {route === "periodicForm" && (
              <PeriodicForm
                key={formSession}
                initial={periodicDraft}
                language={settings.language}
                online={connection.online}
                onChange={(value) => {
                  periodicDrafts.current.set(
                    periodicSelected?.id ?? "new",
                    value,
                  );
                  if (
                    activePage.current.route === "periodicForm" &&
                    activePage.current.session === formSession
                  )
                    setPeriodicDraft(value);
                }}
                onSaved={(rule, submitted) => {
                  const key = submitted.original?.id ?? "new",
                    latest = periodicDrafts.current.get(key) ?? submitted;
                  const sameSession = latest.sessionId === submitted.sessionId;
                  const retained =
                    sameSession && latest.key !== submitted.key
                      ? { ...latest, original: rule, key: crypto.randomUUID() }
                      : undefined;
                  if (sameSession) {
                    periodicDrafts.current.delete(key);
                    if (retained) periodicDrafts.current.set(rule.id, retained);
                  }
                  if (
                    activePage.current.route === "periodicForm" &&
                    activePage.current.session === formSession
                  ) {
                    setPeriodicSelected(rule);
                    if (retained) setPeriodicDraft(retained);
                    else {
                      history.current.pop();
                      setRoute("periodic");
                    }
                  } else if (
                    activePage.current.route === "periodicForm" &&
                    sameSession
                  ) {
                    const rebased = retained ?? {
                      ...newPeriodicDraft(rule, settings.language),
                      sessionId: submitted.sessionId,
                    };
                    setPeriodicDraft((current) =>
                      current.sessionId === submitted.sessionId
                        ? rebased
                        : current,
                    );
                    setPeriodicSelected((current) =>
                      current?.id === rule.id ? rule : current,
                    );
                  }
                  void refresh();
                }}
              />
            )}
            {route === "detail" && !selected && (
              <NotFoundPage language={settings.language} loading={!board} onBack={back} />
            )}
            {route === "detail" && selected && (
              <Detail
                key={selected.id}
                task={selected}
                language={settings.language}
                today={board?.context.today ?? calendarState.anchor}
                online={connection.online}
                busy={saving || finishing.has(selected.id)}
                eventRevision={eventRevision}
                onEdit={edit}
                onComplete={complete}
                onNotify={notify}
                onUpdated={(task) =>
                  setSelected((current) =>
                    current?.id === task.id ? task : current,
                  )
                }
                onDeleted={back}
                onRequestDelete={setPendingDelete}
                onChanged={refresh}
                onError={setError}
              />
            )}
            {route === "form" && (
              <Composer
                key={formSession}
                task={draft.original ?? selected}
                initial={draft}
                language={settings.language}
                online={connection.online}
                today={board?.context.today ?? calendarState.anchor}
                onChange={(value) => {
                  const key = selected?.id ?? "new";
                  drafts.current.set(key, value);
                  if (
                    activePage.current.route === "form" &&
                    activePage.current.session === formSession
                  )
                    setDraft(value);
                }}
                onSaved={(task, submitted) => {
                  notify({
                    message: submitted.original
                      ? settings.language === "en" ? "Saved" : "已保存"
                      : submitted.repeat !== "none"
                        ? settings.language === "en" ? "Repeating task created" : "已创建重复任务"
                        : settings.language === "en" ? `Added “${task.title}”` : `已添加「${task.title}」`,
                  });
                  const key = submitted.original?.id ?? "new";
                  const cached = drafts.current.get(key);
                  const ownDraft =
                    !cached || cached.sessionId === submitted.sessionId;
                  const retained = ownDraft
                    ? afterSave(cached ?? submitted, submitted, task)
                    : undefined;
                  if (ownDraft) {
                    if (retained) {
                      drafts.current.delete(key);
                      drafts.current.set(task.id, retained);
                    } else drafts.current.delete(key);
                  }
                  if (
                    activePage.current.route === "form" &&
                    activePage.current.session === formSession
                  ) {
                    setSelected(task);
                    if (retained) setDraft(retained);
                    else {
                      const previous = history.current.pop();
                      setRoute(
                        submitted.original
                          ? "detail"
                          : (previous?.route ?? "list"),
                      );
                      setQuick("");
                    }
                  } else if (activePage.current.route === "form" && ownDraft) {
                    // Reopening the same logical draft creates a new mounted form. Its own earlier
                    // save still advances the version, without closing the reopened editor.
                    const rebased = retained ?? {
                      ...newDraft(task),
                      sessionId: submitted.sessionId,
                    };
                    setDraft((current) =>
                      current.sessionId === submitted.sessionId
                        ? rebased
                        : current,
                    );
                    setSelected((current) =>
                      current?.id === task.id ? task : current,
                    );
                  }
                  void refresh();
                }}
              />
            )}
            {route === "settings" && (
              <SettingsPage
                settings={settings}
                setSettings={setSettings}
                online={connection.online}
                onError={setError}
                onReconnect={refresh}
              />
            )}
          </RouteSurface>
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {toast && (
          <motion.aside
            key={toast.id}
            className={`toast graphite ${toast.kind === "error" ? "toast-error" : ""} ${route !== "list" && route !== "calendar" ? "toast-top" : ""}`}
            role={toast.kind === "error" ? "alert" : "status"}
            style={{ transformOrigin: route !== "list" && route !== "calendar" ? "top" : "bottom" }}
            initial={
              reduced
                ? { opacity: 0 }
                : { opacity: 0, y: route !== "list" && route !== "calendar" ? -16 : 16, scale: 0.96 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              reduced
                ? { opacity: 0, transition: { duration: 0.12 } }
                : { opacity: 0, scale: 0.96, transition: { duration: 0.14, ease: "easeIn" } }
            }
            transition={reduced ? { duration: 0.12 } : motionTokens.settle}
          >
            <span className="toast-message">{toast.message}</span>
            {toast.undo && (
              <button
                className="toast-undo"
                disabled={!connection.online || saving || !!taskDrag.drag}
                title={`${settings.language === "en" ? "Undo" : "撤销"} (${chord("Z")})`}
                onClick={() => void undoAction(toast.undo!)}
              >
                {settings.language === "en" ? "Undo" : "撤销"}
              </button>
            )}
            <button
              className="toast-close"
              aria-label={settings.language === "en" ? "Dismiss" : "关闭提示"}
              onClick={() => dismiss(toast.id)}
            >
              <Icon name="close" size={10} />
            </button>
          </motion.aside>
        )}
      </AnimatePresence>
      {contextMenu.node}
    </main>
  );
}

function RouteSurface({
  children,
  reduced,
  depth,
  reveal,
}: {
  children: import("react").ReactNode;
  reduced: boolean;
  depth: number;
  reveal?: { x: MotionValue<number> };
}) {
  const present = useIsPresent();
  return (
    <motion.div
      className="page-content"
      inert={!present}
      aria-hidden={!present}
      style={{ zIndex: depth, x: reveal?.x }}
      initial={{ y: reduced ? 0 : 14, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{
        opacity: 0,
        transition: { duration: reduced ? 0.12 : 0.1, ease: "easeIn" },
      }}
      transition={{
        y: spring(0.34, 0.9),
        opacity: { duration: 0.12, ease: "easeOut" },
      }}
    >
      {children}
    </motion.div>
  );
}
