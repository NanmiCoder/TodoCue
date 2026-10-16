import { useReducedMotion } from "./useReducedMotion.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
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
  saveSettings,
  startDrag,
  type DesktopSettings,
  defaults,
} from "./bridge.js";
import { translate } from "./i18n.js";
import { Gauge, Mark, Numeral, TaskRow } from "./components.js";
import { Composer } from "./Composer.js";
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
import { dayLabel, planDate } from "./dates.js";
import type { PeriodicReminder } from "@todocue/shared";
import { motionTokens, spring } from "./tokens.js";
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
  const [orderUndo, setOrderUndo] = useState<string | null>(null);
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
  const [recording, setRecording] = useState(false);
  const [quickFocused, setQuickFocused] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [quick, setQuick] = useState("");
  const [selected, setSelected] = useState<Task | undefined>();
  const [draft, setDraft] = useState<TaskDraft>(() => newDraft());
  const [finishing, setFinishing] = useState<Set<string>>(new Set());
  const finishingRef = useRef(new Set<string>());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [undo, setUndo] = useState<Task | null>(null);
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
  const reduced = useReducedMotion();
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
      try {
        const result = await client.moveTask(id, input, {
          idempotencyKey: crypto.randomUUID(),
        });
        setOrderUndo(result.undoToken ?? null);
      } catch (error) {
        if (
          (error as { code?: string }).code === "DEADLINE_CONFIRMATION_REQUIRED"
        ) {
          setPendingMove({ id, input });
          return;
        }
        throw error;
      }
      await refresh();
      await new Promise((resolve) => setTimeout(resolve, 220));
    },
  });
  const [pendingMove, setPendingMove] = useState<{
    id: string;
    input: import("@todocue/shared").MoveTaskInput;
  } | null>(null);
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
      if (event.key === "Escape") {
        if (menuOpen) setMenuOpen(false);
        else if (route !== "list") back();
        else if (search) setSearch("");
        else if (!panelPinned) void hidePanel();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        navigate(route === "calendar" ? "list" : "calendar");
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        edit();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        void focusPanel().catch(error => setError(String(error)));
        pendingQuickFocus.current = true;
        setQuickFocusTick(value => value + 1);
        if (route !== "list") {
          navigate("list");
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void refresh();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        navigate("settings");
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "[") {
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
    search,
    quick,
    calendarState.selected,
    liveBoard?.context.today,
    selected?.id,
    settings.language,
  ]);
  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 10000);
    return () => clearTimeout(timer);
  }, [undo]);
  useEffect(() => {
    if (!orderUndo) return;
    const timer = setTimeout(() => setOrderUndo(null), 10000);
    return () => clearTimeout(timer);
  }, [orderUndo]);
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
        .catch(() => {});
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
  async function run(action: () => Promise<unknown>) {
    if (!connection.online || saving) return;
    setSaving(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      if (error instanceof TodoCueError && error.code === "VERSION_CONFLICT")
        setConflict(true);
    } finally {
      setSaving(false);
    }
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
      setUndo(task.status === "done" ? null : result.task);
      if (selected?.id === task.id) setSelected(result.task);
      await refresh();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      finishingRef.current.delete(task.id);
      setFinishing(new Set(finishingRef.current));
    }
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
          className="drag-card graphite"
          style={{
            position: "fixed",
            left: taskDrag.drag.x,
            top: taskDrag.drag.y,
            width: taskDrag.drag.width,
            pointerEvents: "none",
            zIndex: 40,
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
      {pendingMove && (
        <div className="confirmation frost" role="alertdialog">
          <h3>
            {settings.language === "en"
              ? "Plan is past the deadline"
              : "计划晚于截止时间"}
          </h3>
          <button
            className="pill"
            onClick={() =>
              void run(async () => {
                await client.moveTask(
                  pendingMove.id,
                  { ...pendingMove.input, allowPastDeadline: true },
                  { idempotencyKey: crypto.randomUUID() },
                );
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
      <header className="tile graphite panel-header" data-route={route}>
        <div className="brand">
          {route === "list" ? (
            <Mark />
          ) : (
            <button
              className="icon-button back-button"
              onClick={back}
              aria-label={t("cancel")}
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
            >
              <Icon name="calendar" />
            </button>
          )}
          <button
            className={`icon-button ${panelPinned ? "is-pinned" : ""}`}
            onClick={() => setPanelPinned((value) => !value)}
            aria-label={settings.language === "en" ? "Pin panel" : "固定面板"}
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
          >
            <Icon name="more" />
          </button>
          <button
            className="icon-button"
            onClick={() => void hidePanel()}
            aria-label={t("hide")}
          >
            <Icon name="close" />
          </button>
        </div>
        {route === "list" ? (
          <>
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
          </>
        ) : (
          route !== "detail" && (
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
          )
        )}
        {!connection.online && (
          <div className="offline-banner">{t("offline")}</div>
        )}
      </header>
      {menuOpen && (
        <div
          className="header-menu graphite"
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            onClick={() => {
              edit();
              setMenuOpen(false);
            }}
          >
            <Icon name="plus" />
            {t("newTask")}
          </button>
          <button
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
                    onOpen={openTask}
                    onComplete={async (task) => {
                      return complete(task, true);
                    }}
                    onError={setError}
                  />
                )}
                {route === "list" && (
                  <div className="list-scroll">
                    {view === "today" && next && (
                      <section className="tile frost next-card">
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
                          <div>
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
                          </div>
                          <Gauge
                            completed={completed}
                            total={count + completed}
                          />
                        </div>
                      </section>
                    )}
                    <section
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
                        </div>
                      )}
                      {!board && connection.online ? (
                        <div className="skeleton" />
                      ) : visibleCount === 0 ? (
                        <div className="empty-state">
                          <div className="empty-ring">
                            <span className="orange-disc">
                              <Icon
                                name={completed > 0 ? "check" : "plus"}
                                size={22}
                              />
                            </span>
                          </div>
                          <h2>
                            {settings.language === "en"
                              ? completed > 0
                                ? "Today is clear"
                                : "Start with one small thing"
                              : completed > 0
                                ? "今天已清空"
                                : "从一件小事开始"}
                          </h2>
                          <p>
                            {settings.language === "en"
                              ? "Write it down, and let it go."
                              : "记下来，就不用一直惦记。"}
                          </p>
                          <button
                            className="pill"
                            onClick={() => quickInput.current?.focus()}
                          >
                            <span className="orange-disc">
                              <Icon name="plus" />
                            </span>
                            {t("newTask")}
                          </button>
                        </div>
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
                                          setOrderUndo(result.undoToken);
                                        })
                                      }
                                      aria-label={
                                        settings.language === "en"
                                          ? `Restore automatic order in ${group.label}`
                                          : `${group.label}恢复自动排序`
                                      }
                                    >
                                      <Icon name="repeat" size={10} />
                                    </button>
                                  )}
                                </h3>
                              )}
                              <AnimatePresence initial={false}>
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
                          {completedExpanded &&
                            board?.today.completed.map((task) => (
                              <TaskRow
                                key={task.id}
                                task={task}
                                today={board.context.today}
                                disabled={!connection.online || saving}
                                onOpen={openTask}
                                onComplete={(task) => complete(task, true)}
                              />
                            ))}
                        </div>
                      )}
                    </section>
                  </div>
                )}
                <form
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
                        await client.createTask(payload, { idempotencyKey: operation.key });
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
                </form>
              </>
            )}
            {route === "completed" && (
              <CompletedPage
                language={settings.language}
                online={connection.online}
                eventRevision={eventRevision}
                query={completedQuery}
                onQuery={setCompletedQuery}
                onOpen={openTask}
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
                onUpdated={(task) =>
                  setSelected((current) =>
                    current?.id === task.id ? task : current,
                  )
                }
                onDeleted={back}
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
              <section className="tile frost editor">
                <label>
                  {t("language")}
                  <select
                    value={settings.language}
                    onChange={(event) => {
                      const next = {
                        ...settings,
                        language: event.target
                          .value as DesktopSettings["language"],
                      };
                      setSettings(next);
                      void saveSettings(next).catch((error) =>
                        setError(String(error)),
                      );
                    }}
                  >
                    <option value="zh-CN">简体中文</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label>
                  {t("width")}
                  <input
                    type="range"
                    min="300"
                    max="600"
                    value={settings.width}
                    onChange={(event) => {
                      const next = {
                        ...settings,
                        width: Number(event.target.value),
                      };
                      setSettings(next);
                      void saveSettings(next).catch((error) =>
                        setError(String(error)),
                      );
                    }}
                  />
                  <output>{settings.width}</output>
                </label>
                {(["notchEnabled", "quietFullscreen"] as const).map((key) => (
                  <label key={key}>
                    {t(key === "notchEnabled" ? "notch" : "quiet")}
                    <input
                      type="checkbox"
                      checked={settings[key]}
                      onChange={(event) => {
                        const next = {
                          ...settings,
                          [key]: event.target.checked,
                        };
                        setSettings(next);
                        void saveSettings(next).catch((error) =>
                          setError(String(error)),
                        );
                      }}
                    />
                  </label>
                ))}
                <label>
                  {settings.language === "en"
                    ? "Global shortcut"
                    : "全局快捷键"}
                  <button
                    className="shortcut-recorder pill secondary"
                    onClick={(event) => {
                      event.currentTarget.focus();
                      void focusPanel().catch(error => setError(String(error)));
                      setRecording((value) => !value);
                    }}
                    onKeyDown={(event) => {
                      if (!recording) return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        setRecording(false);
                        return;
                      }
                      if (
                        !["Meta", "Control", "Alt", "Shift"].includes(
                          event.key,
                        ) &&
                        (event.metaKey || event.ctrlKey || event.altKey)
                      ) {
                        const shortcut = [
                          event.metaKey ? "Super" : null,
                          event.ctrlKey ? "Control" : null,
                          event.altKey ? "Alt" : null,
                          event.shiftKey ? "Shift" : null,
                          event.code,
                        ]
                          .filter(Boolean)
                          .join("+");
                        const next = { ...settings, shortcut };
                        setRecording(false);
                        void saveSettings(next)
                          .then(() => setSettings(next))
                          .catch((error) => setError(String(error)));
                      }
                    }}
                  >
                    {recording
                      ? settings.language === "en"
                        ? "Press a shortcut…"
                        : "按下快捷键…"
                      : (settings.shortcut ??
                        (settings.language === "en"
                          ? "Record shortcut"
                          : "录制快捷键"))}
                  </button>
                  {settings.shortcut && (
                    <button
                      className="text-button"
                      onClick={() => {
                        const next = { ...settings, shortcut: null };
                        void saveSettings(next)
                          .then(() => setSettings(next))
                          .catch((error) => setError(String(error)));
                      }}
                    >
                      {settings.language === "en" ? "Clear" : "清除"}
                    </button>
                  )}
                </label>
                <label>
                  {settings.language === "en" ? "Open at login" : "登录时启动"}
                  <input
                    type="checkbox"
                    checked={settings.autostart}
                    disabled={!native}
                    onChange={(event) => {
                      const next = {
                        ...settings,
                        autostart: event.target.checked,
                      };
                      void saveSettings(next)
                        .then(() => setSettings(next))
                        .catch((error) => setError(String(error)));
                    }}
                  />
                </label>
                <button
                  className="pill"
                  disabled={!connection.online}
                  onClick={() => void run(() => client.testNotification())}
                >
                  {t("notify")}
                </button>
                <button
                  className="pill secondary"
                  disabled={!connection.online}
                  onClick={() =>
                    void run(() => client.openNotificationSettings())
                  }
                >
                  {t("notifySettings")}
                </button>
              </section>
            )}
          </RouteSurface>
        </AnimatePresence>
      </div>
      {(!connection.online || error || runtimeError || undo || orderUndo) && (
        <aside
          className={`toast graphite ${route !== "list" && route !== "calendar" ? "toast-top" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ??
            runtimeError ??
            (!connection.online
              ? t("offline")
              : orderUndo
                ? settings.language === "en"
                  ? "Order updated"
                  : "排序已更新"
                : t("completed"))}
          {orderUndo && connection.online && (
            <button
              disabled={!!taskDrag.drag || saving}
              onClick={() =>
                void run(async () => {
                  await client.undoOrder({
                    token: orderUndo,
                    expectedRevision: board!.ordering.revision,
                  });
                  setOrderUndo(null);
                })
              }
            >
              {settings.language === "en" ? "Undo" : "撤销"}
            </button>
          )}
          {undo && connection.online && (
            <button
              onClick={() =>
                void run(async () => {
                  await client.reopenTask(undo.id, {
                    expectedVersion: undo.version,
                  });
                  setUndo(null);
                })
              }
            >
              {settings.language === "en" ? "Undo" : "撤销"}
            </button>
          )}
        </aside>
      )}
    </main>
  );
}

function RouteSurface({
  children,
  reduced,
  depth,
}: {
  children: import("react").ReactNode;
  reduced: boolean;
  depth: number;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      className="page-content"
      inert={!present}
      aria-hidden={!present}
      style={{ zIndex: depth }}
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
