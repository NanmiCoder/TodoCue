import { useReducedMotion } from "./useReducedMotion.js";
import {
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  forwardRef,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type {
  Task,
  Series,
  PeriodicReminder,
  CreatePeriodicReminderInput,
} from "@todocue/shared";
import { client } from "./bridge.js";
import { Icon } from "./icons.js";
import { TaskRow } from "./components.js";
import {
  dayLabel,
  dateOf,
  ghostDates,
  planDate,
  reschedule,
  landsAfterDeadline,
  shiftDate,
  calendarFirstWeekday,
  calendarDays,
  weekdayLabels,
  calendarTitle,
  calendarBucket,
} from "./dates.js";
import { motionTokens, spring } from "./tokens.js";
import { LatestRequest } from "./model.js";
import { isCompositionKey } from "./quickAdd.js";
import { useTextAreaSize } from "./useTextAreaSize.js";

interface PageProps {
  language: string;
  online: boolean;
  eventRevision: number;
  onOpen: (task: Task) => void;
  onComplete: (task: Task) => Promise<unknown>;
  onError: (message: string) => void;
}
export interface CalendarState {
  span: "month" | "week";
  anchor: string;
  selected: string;
  collapsed: boolean;
}
export function CalendarPage({
  language,
  online,
  eventRevision,
  onOpen,
  onComplete,
  onError,
  today,
  onQuickDate,
  state,
  setState,
  activeTasks,
}: PageProps & {
  today: string;
  activeTasks: Task[];
  state: CalendarState;
  setState: Dispatch<SetStateAction<CalendarState>>;
  onQuickDate: (date: string) => void;
}) {
  const { span, anchor, selected, collapsed } = state;
  const reduced = useReducedMotion();
  const previousAnchor = useRef(anchor);
  const direction = anchor >= previousAnchor.current ? 1 : -1;
  useEffect(() => { previousAnchor.current = anchor; }, [anchor]);
  const pageElement = useRef<HTMLDivElement>(null);
  const navigator = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const nav = navigator.current;
    if (!nav) return;
    const measure = () => {
      const title = nav.querySelector<HTMLElement>(".month-label > span");
      if (!title) return;
      title.style.fontSize = "13px";
      if (title.scrollWidth > title.clientWidth) title.style.fontSize = `${Math.max(9.1, 13 * title.clientWidth / title.scrollWidth)}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [anchor, span, language]);
  const [available, setAvailable] = useState(440);
  useLayoutEffect(() => {
    const node = pageElement.current;
    if (!node) return;
    const measure = () => setAvailable(node.clientHeight - 38 - 18 - 16 - 10);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const setSpan = (span: CalendarState["span"]) =>
    setState((current) => ({ ...current, span }));
  const setAnchor = (anchor: string) =>
    setState((current) => ({ ...current, anchor }));
  const setSelected = (selected: string) =>
    setState((current) => ({ ...current, selected }));
  const setCollapsed = () =>
    setState((current) => ({ ...current, collapsed: !current.collapsed }));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ task: Task; date: string } | null>(
    null,
  );
  const zh = language !== "en";
  const monthStart = anchor.slice(0, 7) + "-01";
  const firstDay = calendarFirstWeekday(language, globalThis.navigator.language);
  const days = calendarDays(span, anchor, firstDay);
  const from = days[0]!;
  const to = days.at(-1)!;
  const rowCount = days.length / 7;
  const autoCollapsed = available - 120 < rowCount * 28;
  const shownCollapsed = collapsed || autoCollapsed;
  const gridDays = shownCollapsed
    ? calendarDays("week", selected, firstDay)
    : days;
  const cellHeight = Math.min(
    34,
    Math.max(28, (available - 120) / (shownCollapsed ? 1 : rowCount)),
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    void Promise.all([
      client.listTasks({
        status: ["todo", "done", "cancelled", "skipped"],
        from,
        to,
        limit: 1000,
        includeUnscheduled: false,
      }),
      client.listSeries("active"),
    ])
      .then(([result, repeating]) => {
        if (!stopped) {
          setTasks(result.tasks);
          setSeries(repeating.series);
        }
      })
      .catch((error) => {
        if (!stopped) onError(String(error));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [from, to, revision, online, eventRevision]);
  const openIds = new Set(activeTasks.map((task) => task.id));
  const visible = [
    ...activeTasks,
    ...tasks.filter((task) => !openIds.has(task.id)),
  ];
  const existing = new Set(
    visible
      .filter((task) => task.seriesId)
      .map((task) => `${task.seriesId}:${task.occurrenceDate}`),
  );
  const ghosts = series.flatMap((rule) =>
    ghostDates(rule, from, to, existing).map((date) => ({
      date,
      title: rule.title,
    })),
  );
  const planned = (day: string) =>
    calendarBucket(visible, day).planned;
  const history = (day: string) => calendarBucket(visible, day).history;
  const deadlines = (day: string) =>
    calendarBucket(visible, day).deadlines;
  const bucket = (day: string) => [...planned(day), ...deadlines(day)];
  const showsHistory = (day: string) => historyExpanded[day] ?? (bucket(day).length === 0 && !ghosts.some(ghost => ghost.date === day));
  const marks = (day: string) => [
    ...deadlines(day).map(task => ({ key: `due:${task.id}`, kind: "deadline" })),
    ...planned(day).map(task => ({ key: task.id, kind: "todo" })),
    ...history(day).map(task => ({ key: task.id, kind: "done" })),
    ...ghosts.filter(ghost => ghost.date === day).map((_, index) => ({ key: `ghost:${index}`, kind: "ghost" })),
  ];
  function page(direction: number) {
    if (span === "week") setAnchor(shiftDate(anchor, 7 * direction));
    else {
      const date = new Date(`${monthStart}T12:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + direction);
      setAnchor(date.toISOString().slice(0, 10));
    }
  }
  async function move(task: Task, date: string, allow = false) {
    if (!online) return;
    if (landsAfterDeadline(task, date) && !allow) {
      setConfirm({ task, date });
      return;
    }
    try {
      await client.updateTask(task.id, reschedule(task, date));
      setRevision((value) => value + 1);
      setConfirm(null);
    } catch (error) {
      onError(String(error));
    }
  }
  return (
    <div className="calendar-page" ref={pageElement}>
      <motion.section className="tile frost calendar-grid" layout={!reduced} transition={reduced ? { duration: 0.12 } : motionTokens.snap}>
        <div className="calendar-nav" ref={navigator}>
          <div className="segment" role="group" aria-label={zh ? "日历视图切换" : "Calendar view"}>
            <button
              className={span === "month" ? "selected" : ""}
              aria-pressed={span === "month"}
              onClick={() => setSpan("month")}
            >
              {zh ? "按月" : "Month"}
            </button>
            <button
              className={span === "week" ? "selected" : ""}
              aria-pressed={span === "week"}
              onClick={() => setSpan("week")}
            >
              {zh ? "按周" : "Week"}
            </button>
          </div>
          <span className="calendar-nav-space" />
          {span === "month" && !autoCollapsed && <button className="icon-button" onClick={setCollapsed}
            aria-label={zh ? (shownCollapsed ? "展开月历" : "收起月历") : (shownCollapsed ? "Expand month" : "Collapse month")}>
            <Icon name="chevron" size={12} style={{ transform: shownCollapsed ? "rotate(90deg)" : "rotate(-90deg)" }} />
          </button>}
          <button
            className="icon-button"
            onClick={() => page(-1)}
            aria-label={zh ? (span === "month" ? "上个月" : "上一周") : (span === "month" ? "Previous month" : "Previous week")}
          >
            <Icon name="back" size={12} />
          </button>
          <button className="month-label" aria-label={zh ? "回到今天" : "Go to today"} onClick={() => {
            setAnchor(today); setSelected(today); onQuickDate(today);
          }}>
            <span>{calendarTitle(span, anchor, language, firstDay, today)}</span>
            {!(today >= from && today <= to) && <i aria-hidden="true" className="calendar-today-dot" />}
          </button>
          <button
            className="icon-button"
            onClick={() => page(1)}
            aria-label={zh ? (span === "month" ? "下个月" : "下一周") : (span === "month" ? "Next month" : "Next week")}
          >
            <Icon name="chevron" size={12} />
          </button>
        </div>
        {span === "month" && (
          <>
            <div className="weekday-labels">
              {weekdayLabels(language, firstDay).map((day, i) => (
                <span key={i}>{day}</span>
              ))}
            </div>
            <div className="calendar-month-stage">
            <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <CalendarSwap className="month-days" key={`${from}:${shownCollapsed}`} direction={direction}>
              {gridDays.map((day) => (
                <button
                  style={{ height: cellHeight }}
                  key={day}
                  className={`${selected === day ? "selected" : ""} ${day.slice(0, 7) !== anchor.slice(0, 7) ? "other-month" : ""} ${day === today ? "is-today" : ""}`}
                  onClick={() => {
                    setSelected(day);
                    onQuickDate(day);
                  }}
                  onDragOver={(event) => {
                    if (online) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const task = visible.find(
                      (task) =>
                        task.id ===
                        event.dataTransfer.getData(
                          "application/x-todocue-task",
                        ),
                    );
                    if (task) void move(task, day);
                  }}
                  aria-label={day}
                  aria-pressed={selected === day}
                  aria-description={`${dayLabel(day, language, today)} · ${planned(day).length} ${zh ? "待办" : "planned"} · ${deadlines(day).length} ${zh ? "截止" : "due"} · ${history(day).length} ${zh ? "历史" : "completed"}`}
                >
                  <span className="calendar-date">
                    {selected === day && <motion.i className="calendar-selection" layoutId={reduced ? undefined : `calendar-selection:${from}`} transition={reduced ? { duration: 0.12 } : motionTokens.snap} />}
                    <span>{Number(day.slice(-2))}</span>
                  </span>
                  <div className="day-dots">
                    {marks(day)
                      .slice(0, 3)
                      .map((mark, index) => (
                        <i
                          key={mark.key}
                          className={`${mark.kind} ${marks(day).length > 3 && index === 2 ? "overflow" : ""}`}
                        />
                      ))}
                  </div>
                </button>
              ))}
            </CalendarSwap>
            </AnimatePresence>
            </div>
          </>
        )}
      </motion.section>
      <section className="tile graphite calendar-agenda" aria-busy={loading}>
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <CalendarSwap className="calendar-agenda-days" key={span === "week" ? `week:${from}` : `day:${selected}`} direction={direction} distance={span === "week" ? 24 : 0}>
        {(span === "week" ? days : [selected]).map((day) => (
          <section
            className="day-agenda"
            key={day}
            onDragOver={(event) => {
              if (online) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const task = visible.find(
                (task) =>
                  task.id ===
                  event.dataTransfer.getData("application/x-todocue-task"),
              );
              if (task) void move(task, day);
            }}
          >
            <h3 className={day === today ? "is-today" : ""}>
              {dayLabel(day, language, today)} {planned(day).length > 0 && <span>{planned(day).length}</span>}
            </h3>
            {bucket(day).length === 0 &&
              history(day).length === 0 &&
              !ghosts.some((ghost) => ghost.date === day) && (
                <p className="muted">
                  {zh ? "这天没有安排" : "Nothing planned"}
                </p>
              )}
            {planned(day).map((task) => (
              <div
                key={task.id}
                draggable={online && task.status === "todo"}
                onDragStart={(event) =>
                  event.dataTransfer.setData(
                    "application/x-todocue-task",
                    task.id,
                  )
                }
              >
                <TaskRow
                  task={task}
                  today={today}
                  disabled={!online || !["todo", "done"].includes(task.status)}
                  onOpen={onOpen}
                  onComplete={async (task) => {
                    const result = await onComplete(task);
                    if (result !== false) setRevision((value) => value + 1);
                    return result;
                  }}
                />
              </div>
            ))}
            {deadlines(day).length > 0 && (
              <>
                <h3 className="deadline-heading">
                  {zh ? "截止" : "Due"}
                  <span>{deadlines(day).length}</span>
                </h3>
                {deadlines(day).map((task) => (
                  <TaskRow
                    key={`due:${task.id}`}
                    task={task}
                    disabled={!online}
                    onOpen={onOpen}
                    onComplete={onComplete}
                  />
                ))}
              </>
            )}
            {ghosts
              .filter((ghost) => ghost.date === day)
              .map((ghost, i) => (
                <div key={i} className="ghost-row">
                  <Icon name="repeat" />
                  {ghost.title}
                  <span>{zh ? "待生成" : "Not generated"}</span>
                </div>
              ))}
            {history(day).length > 0 && <div className="calendar-history">
              <button type="button" className="calendar-history-toggle" aria-expanded={showsHistory(day)}
                aria-label={zh ? `${showsHistory(day) ? "收起" : "展开"}已完成 ${day}` : `${showsHistory(day) ? "Collapse" : "Expand"} completed ${day}`}
                onClick={() => setHistoryExpanded(current => ({ ...current, [day]: !showsHistory(day) }))}>
                <Icon name="chevron" size={10} style={{ transform: showsHistory(day) ? "rotate(90deg)" : undefined }} />
                {zh ? "已完成" : "Completed"} <span>{history(day).length}</span>
              </button>
              {showsHistory(day) && history(day).map(task => <TaskRow key={task.id} task={task} today={today}
                disabled={!online || task.status !== "done"} onOpen={onOpen}
                onComplete={async task => { const result = await onComplete(task); if (result !== false) setRevision(value => value + 1); return result; }} />)}
            </div>}
          </section>
        ))}
        </CalendarSwap>
        </AnimatePresence>
      </section>
      {confirm && (
        <div className="confirmation frost" role="alertdialog">
          <h3>{zh ? "计划晚于截止时间" : "Plan is past the deadline"}</h3>
          <p>
            {zh
              ? "截止日期和提醒时间将保持原值。"
              : "Deadline and reminder will be kept."}
          </p>
          <button
            className="pill"
            disabled={!online}
            onClick={() => void move(confirm.task, confirm.date, true)}
          >
            {zh ? "保留截止日期并改期" : "Reschedule"}
          </button>
          <button className="text-button" onClick={() => setConfirm(null)}>
            {zh ? "取消" : "Cancel"}
          </button>
        </div>
      )}
    </div>
  );
}

const CalendarSwap = forwardRef<HTMLDivElement, { children: ReactNode; className: string; direction: number; distance?: number }>(function CalendarSwap({ children, className, direction, distance = 24 }, ref) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return <motion.div ref={ref} className={className} inert={!present} aria-hidden={!present} custom={direction}
    variants={{ enter: (direction: number) => ({ x: reduced ? 0 : direction * distance, opacity: 0 }) }}
    initial="enter" animate={{ x: 0, opacity: 1 }}
    exit={{ opacity: 0, transition: { duration: 0.1, ease: "easeIn" } }}
    transition={reduced ? { duration: 0.12 } : { x: spring(0.34, 0.9), opacity: { duration: 0.14, ease: "easeOut" } }}
  >{children}</motion.div>;
});

export function CompletedPage({
  language,
  online,
  eventRevision,
  onOpen,
  onError,
  query,
  onQuery,
}: PageProps & { query: string; onQuery: (query: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const zh = language !== "en";
  const history = useRef(new LatestRequest());
  const reload = () => history.current.run(
    () => client.listTasks({ status: "done", limit: 1000 }),
    (result) => setTasks(result.tasks),
    (error) => onError(String(error)),
  );
  useEffect(() => {
    void reload();
    return () => history.current.invalidate();
  }, [online, eventRevision]);
  const matching = tasks.filter((task) =>
    [task.title, task.project ?? "", task.notes ?? ""].some((text) =>
      text.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  const dates = [
    ...new Set(
      matching.map((task) =>
        task.completedAt
          ? dateOf(task.completedAt, task.timezone)
          : task.updatedAt.slice(0, 10),
      ),
    ),
  ]
    .sort()
    .reverse();
  return (
    <>
      <section className="tile frost completed-search">
        <div className="search-field">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={zh ? "搜索已完成的任务" : "Search completed tasks"}
            aria-label={zh ? "搜索已完成" : "Search completed"}
          />
        </div>
        <span className="muted">
          {matching.length} {zh ? "件已完成" : "completed"}
        </span>
      </section>
      <section className="tile graphite completed-list">
        {dates.map((date) => (
          <section key={date}>
            <h3>
              {dayLabel(date, language)} <span>{date}</span>
            </h3>
            {matching
              .filter((task) =>
                task.completedAt
                  ? dateOf(task.completedAt, task.timezone) === date
                  : task.updatedAt.startsWith(date),
              )
              .map((task) => (
                <div className="completed-row" key={task.id}>
                  <button
                    className="check is-done"
                    aria-label={`${zh ? "重新打开" : "Reopen"} ${task.title}`}
                    disabled={!online}
                    onClick={() =>
                      void client
                        .reopenTask(task.id, { expectedVersion: task.version })
                        .then(reload)
                        .catch((error) => onError(String(error)))
                    }
                  >
                    <Icon name="check" size={12} />
                  </button>
                  <button className="task-text" onClick={() => onOpen(task)}>
                    <span>{task.title}</span>
                    <span className="muted">{task.project}</span>
                  </button>
                </div>
              ))}
          </section>
        ))}
        {matching.length === 0 && (
          <p className="empty">
            {zh ? "这里会留下你做过的事。" : "Your finished work lives here."}
          </p>
        )}
      </section>
    </>
  );
}

export function PeriodicPage({
  language,
  online,
  rules,
  onEdit,
  onChanged,
  onError,
}: {
  language: string;
  online: boolean;
  rules: PeriodicReminder[];
  onEdit: (rule?: PeriodicReminder) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const zh = language !== "en";
  const [busy, setBusy] = useState<string | null>(null);
  async function act(
    rule: PeriodicReminder,
    action: "pause" | "resume" | "pause_today" | "delete" | "complete",
  ) {
    if (!online || busy) return;
    setBusy(rule.id);
    try {
      await client.periodicAction(rule.id, {
        action,
        expectedVersion: rule.version,
        occurrenceId: rule.currentOccurrenceId ?? undefined,
        round: rule.currentOccurrence?.round,
      });
      await onChanged();
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="tile frost periodic-page">
      <div className="page-toolbar">
        <span className="muted">
          {zh ? "给日常留一点提醒" : "A cue for your daily rhythm"}
        </span>
        <button
          className="pill secondary"
          disabled={!online}
          onClick={() => onEdit()}
        >
          <Icon name="plus" />
          {zh ? "新建" : "New"}
        </button>
      </div>
      <div className="page-scroll">
        {rules.length === 0 && (
          <div className="empty-state">
            <Icon name="clock" size={30} />
            <h2>
              {zh
                ? "喝水、活动，按你的节奏提醒"
                : "Water and movement, at your pace"}
            </h2>
            <button
              className="pill"
              disabled={!online}
              onClick={() => onEdit()}
            >
              {zh ? "创建第一个提醒" : "Create a reminder"}
            </button>
          </div>
        )}
        {rules.map((rule) => (
          <article className="surface-card periodic-row" key={rule.id}>
            <div>
              <button className="periodic-title" onClick={() => onEdit(rule)}>
                {rule.title}
              </button>
              <input
                type="checkbox"
                role="switch"
                checked={rule.enabled}
                aria-label={`${zh ? "启用" : "Enable"} ${rule.title}`}
                disabled={!online || busy === rule.id}
                onChange={() =>
                  void act(rule, rule.enabled ? "pause" : "resume")
                }
              />
            </div>
            <p className="muted">
              {zh
                ? rule.summary
                : `${rule.windows.map((window) => `${window.start}–${window.end}`).join(", ")} · Every ${rule.intervalMinutes} minutes`}
            </p>
            <div>
              <span className={rule.state === "waiting" ? "accent" : "muted"}>
                {zh
                  ? {
                      waiting: "等待确认",
                      scheduled: "已安排",
                      paused: "已暂停",
                      paused_today: "今天暂停",
                    }[rule.state]
                  : rule.state.replaceAll("_", " ")}
              </span>
              <details className="action-menu">
                <summary aria-label={zh ? "管理周期提醒" : "Manage reminder"}>
                  <Icon name="more" />
                </summary>
                <div className="frost">
                  <button onClick={() => onEdit(rule)}>
                    {zh ? "编辑" : "Edit"}
                  </button>
                  {rule.state === "waiting" && (
                    <button
                      disabled={!online || !!busy}
                      onClick={() => void act(rule, "complete")}
                    >
                      {zh ? "完成本次" : "Complete"}
                    </button>
                  )}
                  <button
                    disabled={!online || !!busy}
                    onClick={() =>
                      void act(
                        rule,
                        rule.state === "paused_today"
                          ? "resume"
                          : "pause_today",
                      )
                    }
                  >
                    {zh
                      ? rule.state === "paused_today"
                        ? "恢复提醒"
                        : "今天暂停"
                      : "Pause / Resume today"}
                  </button>
                  <button
                    className="danger"
                    disabled={!online || !!busy}
                    onClick={() => void act(rule, "delete")}
                  >
                    {zh ? "删除" : "Delete"}
                  </button>
                </div>
              </details>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export interface PeriodicDraft {
  sessionId: string;
  key: string;
  original?: PeriodicReminder;
  config: CreatePeriodicReminderInput;
}
export function newPeriodicDraft(
  rule?: PeriodicReminder,
  language = "zh-CN",
): PeriodicDraft {
  return {
    sessionId: crypto.randomUUID(),
    key: crypto.randomUUID(),
    original: rule,
    config: {
      title:
        rule?.title ?? (language !== "en" ? "起来活动一下" : "Time to move"),
      intervalMinutes: rule?.intervalMinutes ?? 30,
      weekdays: rule?.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
      windows: rule?.windows ?? [{ start: "09:00", end: "18:00" }],
      mode: rule?.mode ?? "fixed",
      enabled: rule?.enabled ?? true,
      timezone:
        rule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}
export function PeriodicForm({
  initial,
  language,
  online,
  onChange,
  onSaved,
}: {
  initial: PeriodicDraft;
  language: string;
  online: boolean;
  onChange: (draft: PeriodicDraft) => void;
  onSaved: (rule: PeriodicReminder, submitted: PeriodicDraft) => void;
}) {
  const zh = language !== "en";
  const [draft, setDraft] = useState(initial);
  const current = useRef(initial);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  useTextAreaSize(titleInput, draft.config.title, 2, 4);
  const mounted = useRef(true);
  const [preview, setPreview] = useState<{
    summary: string;
    nextFireAt: string | null;
  } | null>(null);
  useEffect(() => {
    if (!online) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void client
        .previewPeriodicReminder(draft.config)
        .then((result) => {
          if (!stopped) setPreview(result);
        })
        .catch(() => {
          if (!stopped) setPreview(null);
        });
    }, 250);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [draft.config, online]);
  const config = draft.config;
  const setConfig = (config: CreatePeriodicReminderInput) => {
    const next = { ...current.current, config, key: crypto.randomUUID() };
    current.current = next;
    setDraft(next);
    onChange(next);
  };
  useEffect(() => {
    current.current = initial;
    setDraft(initial);
  }, [initial]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savePending = useRef(false);
  async function save() {
    if (savePending.current || !online || conflict) return;
    savePending.current = true;
    const submitted = current.current;
    setBusy(true);
    setError(null);
    try {
      const { reminder } = submitted.original
        ? await client.updatePeriodicReminder(
            submitted.original.id,
            {
              ...submitted.config,
              expectedVersion: submitted.original.version,
            },
            { idempotencyKey: submitted.key },
          )
        : await client.createPeriodicReminder(submitted.config, {
            idempotencyKey: submitted.key,
          });
      onSaved(reminder, submitted);
    } catch (error) {
      if (mounted.current) {
        setError(String(error));
        setConflict((error as { code?: string }).code === "VERSION_CONFLICT");
      }
    } finally {
      savePending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="tile frost composer-page"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !isCompositionKey(event.nativeEvent)
        ) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div className="page-scroll">
        <div className="template-pills">
          {[
            zh ? "活动" : "Movement",
            zh ? "喝水" : "Water",
            zh ? "自定义" : "Custom",
          ].map((text, i) => (
            <button
              className="pill secondary"
              key={text}
              onClick={() =>
                setConfig({
                  ...config,
                  title:
                    i === 0
                      ? zh
                        ? "起来活动一下"
                        : "Time to move"
                      : i === 1
                        ? zh
                          ? "喝点水"
                          : "Have some water"
                        : "",
                })
              }
            >
              {text}
            </button>
          ))}
        </div>
        <div className="surface-card">
          <textarea
            ref={titleInput}
            className="title-input"
            aria-label={zh ? "提醒标题" : "Reminder title"}
            rows={2}
            value={config.title}
            placeholder={zh ? "提醒什么？" : "What should we remind you?"}
            onChange={(event) =>
              setConfig({ ...config, title: event.target.value })
            }
          />
          <label className="field-row">
            {zh ? "提醒间隔" : "Interval"}
            <input
              type="number"
              min="1"
              max="1440"
              value={config.intervalMinutes}
              onChange={(event) =>
                setConfig({
                  ...config,
                  intervalMinutes: Number(event.target.value),
                })
              }
            />
            {zh ? "分钟" : "minutes"}
          </label>
          <div className="weekday-picker">
            {(zh
              ? ["一", "二", "三", "四", "五", "六", "日"]
              : ["M", "T", "W", "T", "F", "S", "S"]
            ).map((day, index) => (
              <button
                key={index}
                aria-label={weekdayLabels(language, 1, true)[index]}
                aria-pressed={config.weekdays?.includes(index + 1) ?? false}
                className={
                  config.weekdays?.includes(index + 1) ? "selected" : ""
                }
                onClick={() =>
                  setConfig({
                    ...config,
                    weekdays: config.weekdays?.includes(index + 1)
                      ? config.weekdays.filter((day) => day !== index + 1)
                      : [...(config.weekdays ?? []), index + 1],
                  })
                }
              >
                {day}
              </button>
            ))}
          </div>
          {config.windows?.map((window, index) => (
            <div className="field-row" key={index}>
              <input
                type="time"
                value={window.start}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    windows: config.windows!.map((window, i) =>
                      i === index
                        ? { ...window, start: event.target.value }
                        : window,
                    ),
                  })
                }
              />
              <span>—</span>
              <input
                type="time"
                value={window.end === "24:00" ? "23:59" : window.end}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    windows: config.windows!.map((window, i) =>
                      i === index
                        ? { ...window, end: event.target.value }
                        : window,
                    ),
                  })
                }
              />
              <button
                className="icon-button"
                disabled={config.windows!.length === 1}
                onClick={() =>
                  setConfig({
                    ...config,
                    windows: config.windows!.filter((_, i) => i !== index),
                  })
                }
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <button
            className="text-button"
            onClick={() =>
              setConfig({
                ...config,
                windows: [
                  ...(config.windows ?? []),
                  { start: "19:00", end: "21:00" },
                ],
              })
            }
          >
            + {zh ? "添加时段" : "Add window"}
          </button>
        </div>
        <details className="surface-card">
          <summary>{zh ? "更多设置" : "More settings"}</summary>
          <label className="field-row">
            {zh ? "计时方式" : "Timing"}
            <select
              value={config.mode}
              onChange={(event) =>
                setConfig({
                  ...config,
                  mode: event.target.value as "fixed" | "after_completion",
                })
              }
            >
              <option value="fixed">{zh ? "固定时间点" : "Fixed times"}</option>
              <option value="after_completion">
                {zh ? "完成后重新计时" : "After completion"}
              </option>
            </select>
          </label>
          <label className="field-row">
            {zh ? "时区" : "Timezone"}
            <input
              value={config.timezone}
              onChange={(event) =>
                setConfig({ ...config, timezone: event.target.value })
              }
            />
          </label>
        </details>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="form-footer">
        <button
          className="pill"
          disabled={!online || busy || conflict || !config.title.trim()}
          onClick={() => void save()}
        >
          <span className="orange-disc">
            <Icon name="check" />
          </span>
          {zh ? "保存" : "Save"}
        </button>
      </footer>
    </section>
  );
}
