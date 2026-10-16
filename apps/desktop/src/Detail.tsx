import { useEffect, useState, useRef } from "react";
import { useIsPresent } from "motion/react";
import type { Reminder, Series, Task } from "@todocue/shared";
import { client } from "./bridge.js";
import { Icon, type IconName } from "./icons.js";
import { dayLabel, reschedule, ruleLabel, shiftDate, taskOverdue } from "./dates.js";
import { describeError, isVersionConflict } from "./errors.js";
import type { NotifyInput } from "./toast.js";
import { estimateLabel, timeLabel } from "./metadata.js";
import { AttachmentGallery, AttachmentPreview, type FilePreview } from "./Attachments.js";

export function Detail({
  task,
  language,
  today,
  online,
  busy,
  eventRevision,
  onEdit,
  onComplete,
  onUpdated,
  onDeleted,
  onChanged,
  onError,
  onNotify,
}: {
  task: Task;
  language: string;
  today: string;
  online: boolean;
  busy: boolean;
  eventRevision: number;
  onEdit: (task: Task) => void;
  onComplete: (task: Task) => Promise<boolean>;
  onUpdated: (task: Task) => void;
  onDeleted: () => void;
  onChanged: () => Promise<void>;
  onError: (error: string) => void;
  onNotify: (input: NotifyInput) => void;
}) {
  const mounted = useRef(true);
  const present = useIsPresent();
  const visible = useRef(present);
  visible.current = present;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const zh = language !== "en";
  const text = (chinese: string, english: string) => (zh ? chinese : english);
  const [working, setWorking] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "stop" | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [viewing, setViewing] = useState<FilePreview | null>(null);
  const disabled = !online || busy || working;
  const overdue = taskOverdue(task, today);
  const instant = (value: string | null) =>
    value ? timeLabel(value, task.timezone, language, today) : null;
  useEffect(() => {
    let cancelled = false;
    void client
      .listReminders({ taskId: task.id })
      .then(({ reminders }) => {
        if (!cancelled) setReminder(reminders[0] ?? null);
      })
      .catch(() => {});
    if (task.seriesId)
      void client
        .getSeries(task.seriesId)
        .then(({ series }) => {
          if (!cancelled) setSeries(series);
        })
        .catch((error) => onError(String(error)));
    return () => {
      cancelled = true;
    };
  }, [task.id, task.seriesId, eventRevision, online]);
  async function act(
    action: () => Promise<{ task?: Task } | unknown>,
    close = false,
    done?: (result: any) => void,
  ) {
    if (disabled) return;
    setWorking(true);
    try {
      const result = (await action()) as { task?: Task };
      if (result?.task) onUpdated(result.task);
      done?.(result);
      await onChanged();
      if (close && mounted.current && visible.current) onDeleted();
      setConfirm(null);
    } catch (error) {
      onError(describeError(error, language));
      if (isVersionConflict(error)) void onChanged();
    } finally {
      setWorking(false);
    }
  }
  const fields: { label: string; value: string | null; icon: IconName }[] = [
    { label: text("项目", "Project"), value: task.project, icon: "folder" },
    {
      label: text("预计耗时", "Estimate"),
      value: task.estimateMinutes
        ? estimateLabel(task.estimateMinutes, language)
        : null,
      icon: "clock",
    },
    {
      label: text("计划", "Plan"),
      value:
        instant(task.scheduledAt) ??
        (task.scheduledDate
          ? dayLabel(task.scheduledDate, language, today)
          : null),
      icon: "calendar",
    },
    {
      label: text("截止", "Due"),
      value:
        instant(task.dueAt) ??
        (task.dueDate ? dayLabel(task.dueDate, language, today) : null),
      icon: "flag",
    },
    {
      label: text("提醒", "Reminder"),
      value: instant(task.reminderAt),
      icon: "bell",
    },
    { label: text("时区", "Timezone"), value: task.timezone, icon: "clock" },
  ];
  return (
    <section className="tile frost detail-page">
      <div className="detail-scroll">
        <div className="detail-title">
          <span
            className={`detail-status ${overdue ? "overdue" : task.status === "done" ? "accent" : "muted"}`}
          >
            <Icon name={task.status === "done" ? "check" : "clock"} size={12} />
            {overdue ? text("已逾期", "Overdue") : text(
              {
                todo: "待办",
                done: "已完成",
                cancelled: "已取消",
                skipped: "已跳过",
              }[task.status],
              task.status === "todo" ? "To do" : task.status,
            )}
            {task.completedAt && ` · ${instant(task.completedAt)}`}
            {task.priority !== "none" && (
              <span className={`priority-${task.priority}`}>
                <Icon name="priority" size={12} /> {text("优先级", "Priority")}{" "}
                {text(
                  { high: "高", medium: "中", low: "低", none: "无" }[
                    task.priority
                  ],
                  task.priority,
                )}
              </span>
            )}
          </span>
          <h1>{task.title}</h1>
          {task.notes && <p>{task.notes}</p>}
        </div>
        <div className="surface-card">
          <h3>
            <Icon name="paperclip" />
            {text("附件", "Attachments")}
            {task.attachments.length > 0 && ` · ${task.attachments.length}`}
            <button
              className="pill secondary"
              onClick={() => onEdit(task)}
              disabled={disabled}
            >
              {text("添加 / 管理", "Add / Manage")}
            </button>
          </h3>
          {task.attachments.length === 0 ? (
            <p className="muted">
              {text(
                "把图片、文档和灵感放在一起。",
                "Keep files, images and ideas together.",
              )}
            </p>
          ) : (
            <AttachmentGallery taskId={task.id} files={task.attachments} online={online} language={language} onOpen={setViewing} onError={onError} />
          )}
        </div>
        <div className="surface-card">
          <h3>
            <Icon name="calendar" />
            {text("安排", "Schedule")}
          </h3>
          {fields
            .filter((field) => field.value)
            .map((field) => (
              <div className="detail-field" key={field.label}>
                <Icon name={field.icon} size={14} />
                <span>{field.label}</span>
                <span>{field.value}</span>
              </div>
            ))}
        </div>
        {task.seriesId && (
          <div className="series-block">
            <div>
              <Icon name="repeat" />
              <span>
                {series
                  ? ruleLabel(series.rule, language)
                  : text("重复任务", "Repeating task")}
                {series?.scheduledTime && ` · ${series.scheduledTime}`}
                {series?.status === "stopped" &&
                  ` · ${text("已停止", "Stopped")}`}
              </span>
              {series?.status !== "stopped" && (
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() => setConfirm("stop")}
                >
                  {text("停止系列", "Stop series")}
                </button>
              )}
            </div>
            <p className="muted">
              {text(
                "编辑、改期、完成和跳过只影响本次实例。",
                "Edits, moves and completion affect only this instance.",
              )}
            </p>
          </div>
        )}
        {reminder && (
          <p className="reminder-status muted">
            <Icon name="bell" size={12} />
            {text(
              {
                pending: "提醒待发送",
                submitted: "提醒已提交系统",
                failed: "提醒发送失败",
                missed: "错过的提醒已合并提示",
                cancelled: "提醒已取消",
              }[reminder.status],
              reminder.status,
            )}
            {reminder.status === "pending" && ` · ${instant(reminder.fireAt)}`}
            {reminder.lastError && ` · ${reminder.lastError}`}
          </p>
        )}
      </div>
      <footer className="detail-actions">
        <div className="detail-action-row">
          <button
            className="pill secondary"
            onClick={() => onEdit(task)}
            disabled={disabled}
          >
            <Icon name="edit" />
            {text("编辑", "Edit")}
          </button>
          {task.status === "todo" && (
            <details className="action-menu">
              <summary className="pill secondary">
                <Icon name="bell" />
                {text("稍后提醒", "Snooze")}
                <Icon
                  name="chevron"
                  size={9}
                  style={{ transform: "rotate(90deg)" }}
                />
              </summary>
              <div className="frost">
                {[10, 30, 60].map((minutes) => (
                  <button
                    disabled={disabled}
                    key={minutes}
                    onClick={() =>
                      void act(
                        () =>
                          client.snoozeTask(task.id, {
                            minutes,
                            expectedVersion: task.version,
                          }),
                        false,
                        () =>
                          onNotify({
                            message: text(`将在 ${minutes} 分钟后提醒`, `Reminding you in ${minutes} minutes`),
                          }),
                      )
                    }
                  >
                    {minutes} {text("分钟后", "minutes")}
                  </button>
                ))}
              </div>
            </details>
          )}
          <details className="action-menu detail-more">
            <summary aria-label={text("更多任务操作", "More task actions")}>
              <Icon name="more" />
            </summary>
            <div className="frost">
              {task.status === "todo" && (
                <>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void act(
                        () =>
                          client.updateTask(
                            task.id,
                            reschedule(task, shiftDate(today, 1)),
                          ),
                        false,
                        (result: { task: Task }) =>
                          onNotify({
                            message: text("已改期到明天", "Moved to tomorrow"),
                            undo: {
                              kind: "reschedule",
                              taskId: task.id,
                              scheduledDate: task.scheduledDate,
                              scheduledAt: task.scheduledAt,
                              timezone: task.timezone,
                              expectedVersion: result.task.version,
                            },
                          }),
                      )
                    }
                  >
                    {text("改期到明天", "Move to tomorrow")}
                  </button>
                  {task.seriesId && (
                    <button
                      disabled={disabled}
                      onClick={() =>
                        void act(
                          () =>
                            client.skipTask(task.id, {
                              expectedVersion: task.version,
                            }),
                          true,
                        )
                      }
                    >
                      {text("跳过本次", "Skip instance")}
                    </button>
                  )}
                  <button
                    className="danger"
                    disabled={disabled}
                    onClick={() =>
                      void act(
                        () =>
                          client.cancelTask(task.id, {
                            expectedVersion: task.version,
                          }),
                        true,
                      )
                    }
                  >
                    {text("取消任务", "Cancel task")}
                  </button>
                </>
              )}
              <button
                className="danger"
                disabled={disabled}
                onClick={() => setConfirm("delete")}
              >
                {text("删除任务…", "Delete task…")}
              </button>
            </div>
          </details>
        </div>
        <button
          className="pill detail-primary"
          disabled={disabled}
          onClick={() =>
            task.status === "todo"
              ? void onComplete(task).then((success) => {
                  if (success && mounted.current && visible.current)
                    onDeleted();
                })
              : void act(() =>
                  client.reopenTask(task.id, { expectedVersion: task.version }),
                )
          }
        >
          <span className="orange-disc">
            <Icon name={task.status === "todo" ? "check" : "repeat"} />
          </span>
          {text(
            task.status === "todo" ? "标记完成" : "重新打开",
            task.status === "todo" ? "Mark complete" : "Reopen",
          )}
        </button>
      </footer>
      {confirm && (
        <div className="confirmation frost" role="alertdialog">
          <h3>
            {text(
              confirm === "delete" ? "删除这个任务？" : "停止这个重复系列？",
              confirm === "delete" ? "Delete this task?" : "Stop this series?",
            )}
          </h3>
          <p>
            {text(
              confirm === "delete"
                ? "任务、提醒和附件会被永久删除。"
                : "今天之后尚未开始的实例会被取消，历史记录保留。",
              confirm === "delete"
                ? "The task, reminders and attachments will be permanently removed."
                : "Future instances are cancelled. History is kept.",
            )}
          </p>
          <button
            className="pill danger"
            disabled={disabled}
            onClick={() =>
              void act(
                () =>
                  confirm === "delete"
                    ? client.deleteTask(task.id, {
                        expectedVersion: task.version,
                      })
                    : client.stopSeries(task.seriesId!, {
                        expectedVersion: series?.version,
                      }),
                confirm === "delete",
                (result: { cancelledTaskIds?: string[] }) =>
                  onNotify({
                    message:
                      confirm === "delete"
                        ? text(`已删除「${task.title}」`, `Deleted “${task.title}”`)
                        : text(
                            `已停止系列，取消了 ${result?.cancelledTaskIds?.length ?? 0} 个未来实例`,
                            `Series stopped; ${result?.cancelledTaskIds?.length ?? 0} future instances cancelled`,
                          ),
                  }),
              )
            }
          >
            {text(
              confirm === "delete" ? "删除任务" : "停止系列",
              confirm === "delete" ? "Delete task" : "Stop series",
            )}
          </button>
          <button className="text-button" onClick={() => setConfirm(null)}>
            {text("取消", "Cancel")}
          </button>
        </div>
      )}
      {viewing && <AttachmentPreview preview={viewing} language={language} onClose={() => setViewing(null)} />}
    </section>
  );
}
