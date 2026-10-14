import {
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AnimatePresence, motion } from "motion/react";
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
} from "./dates.js";
import { motionTokens } from "./tokens.js";
import { LatestRequest } from "./model.js";

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
  const pageElement = useRef<HTMLDivElement>(null);
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
  const [confirm, setConfirm] = useState<{ task: Task; date: string } | null>(
    null,
  );
  const zh = language !== "en";
  const monthStart = anchor.slice(0, 7) + "-01";
  const weekday = (new Date(`${monthStart}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekDay = (new Date(`${anchor}T12:00:00Z`).getUTCDay() + 6) % 7;
  const from = shiftDate(
    span === "month" ? monthStart : anchor,
    -(span === "month" ? weekday : weekDay),
  );
  const monthDays = new Date(
    Number(anchor.slice(0, 4)),
    Number(anchor.slice(5, 7)),
    0,
  ).getDate();
  const days = Array.from(
    { length: span === "month" ? Math.ceil((monthDays + weekday) / 7) * 7 : 7 },
    (_, i) => shiftDate(from, i),
  );
  const to = days.at(-1)!;
  const rowCount = days.length / 7;
  const autoCollapsed = available - 120 < rowCount * 28;
  const shownCollapsed = collapsed || autoCollapsed;
  const selectedWeekday =
    (new Date(`${selected}T12:00:00Z`).getUTCDay() + 6) % 7;
  const gridDays = shownCollapsed
    ? Array.from({ length: 7 }, (_, i) =>
        shiftDate(selected, i - selectedWeekday),
      )
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
    visible.filter((task) => planDate(task) === day);
  const deadlines = (day: string) =>
    activeTasks.filter(
      (task) =>
        planDate(task) !== day &&
        (task.dueDate ??
          (task.dueAt ? dateOf(task.dueAt, task.timezone) : null)) === day,
    );
  const bucket = (day: string) => [...planned(day), ...deadlines(day)];
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
      <section className="tile frost calendar-grid">
        <div className="calendar-nav">
          <div className="segment">
            <button
              className={span === "month" ? "selected" : ""}
              onClick={() => setSpan("month")}
            >
              {zh ? "月" : "Month"}
            </button>
            <button
              className={span === "week" ? "selected" : ""}
              onClick={() => setSpan("week")}
            >
              {zh ? "周" : "Week"}
            </button>
          </div>
          <button
            className="icon-button"
            onClick={() => page(-1)}
            aria-label={zh ? "上一页" : "Previous"}
          >
            <Icon name="back" size={12} />
          </button>
          <button className="month-label" onClick={() => setCollapsed()}>
            {new Intl.DateTimeFormat(language, {
              year: "numeric",
              month: "short",
            }).format(new Date(`${anchor}T12:00:00`))}
            <Icon
              name="chevron"
              size={10}
              style={{ transform: collapsed ? undefined : "rotate(90deg)" }}
            />
          </button>
          <button
            className="icon-button"
            onClick={() => page(1)}
            aria-label={zh ? "下一页" : "Next"}
          >
            <Icon name="chevron" size={12} />
          </button>
          <button
            className="text-button"
            onClick={() => {
              setAnchor(today);
              setSelected(today);
              onQuickDate(today);
            }}
          >
            {zh ? "今天" : "Today"}
          </button>
        </div>
        {span === "month" && (
          <>
            <div className="weekday-labels">
              {(zh
                ? ["一", "二", "三", "四", "五", "六", "日"]
                : ["M", "T", "W", "T", "F", "S", "S"]
              ).map((day, i) => (
                <span key={i}>{day}</span>
              ))}
            </div>
            <motion.div
              className="month-days"
              key={from}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={motionTokens.snap}
            >
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
                >
                  <span>{Number(day.slice(-2))}</span>
                  <div className="day-dots">
                    {bucket(day)
                      .slice(0, 3)
                      .map((task) => (
                        <i
                          key={task.id}
                          className={task.status === "done" ? "done" : ""}
                        />
                      ))}
                    {ghosts.some((ghost) => ghost.date === day) && (
                      <i className="ghost" />
                    )}
                  </div>
                </button>
              ))}
            </motion.div>
          </>
        )}
      </section>
      <section className="tile graphite calendar-agenda" aria-busy={loading}>
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
            <h3>
              {dayLabel(day, language, today)} <span>{day}</span>
            </h3>
            {bucket(day).length === 0 &&
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
          </section>
        ))}
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
  async function save() {
    if (busy || !online || conflict) return;
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
          !event.nativeEvent.isComposing
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
