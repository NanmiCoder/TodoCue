import type { Task } from "@todocue/shared";
import { dayLabel, dateOf, instantLabel, taskOverdue } from "./dates.js";
import { Icon } from "./icons.js";

export function timeLabel(
  instant: string,
  timezone: string,
  language: string,
  today?: string,
) {
  return instantLabel(instant, timezone, language, today);
}
export function estimateLabel(minutes: number, language: string) {
  if (minutes < 60) return `${minutes} ${language === "en" ? "min" : "分钟"}`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return language === "en"
    ? `${hours}h${rest ? ` ${rest}m` : ""}`
    : `${hours} 小时${rest ? ` ${rest} 分` : ""}`;
}
export function TaskMetadata({
  task,
  language,
  today,
  showProject = true,
  omitTodayTime = false,
}: {
  task: Task;
  language: string;
  today?: string;
  showProject?: boolean;
  omitTodayTime?: boolean;
}) {
  const zh = language !== "en";
  const scheduled = task.scheduledAt
    ? timeLabel(task.scheduledAt, task.timezone, language, today)
    : task.scheduledDate
      ? dayLabel(task.scheduledDate, language, today)
      : null;
  const due = task.dueAt
    ? timeLabel(task.dueAt, task.timezone, language, today)
    : task.dueDate
      ? dayLabel(task.dueDate, language, today)
      : null;
  const omit =
    omitTodayTime &&
    task.scheduledAt &&
    dateOf(task.scheduledAt, task.timezone) === today;
  return (
    <span className="task-meta">
      {task.priority === "high" && (
        <Icon name="flag" size={10} style={{ color: "var(--orange)" }} />
      )}
      {scheduled && !omit && <span>{scheduled}</span>}
      {due && (
        <span
          className={
            taskOverdue(task, today ?? dateOf(new Date().toISOString(), task.timezone))
              ? "overdue"
              : ""
          }
        >
          {zh ? "截止 " : "Due "}
          {due}
        </span>
      )}
      {showProject && task.project && (
        <span className="project-badge">{task.project}</span>
      )}
      {task.estimateMinutes ? (
        <span>{estimateLabel(task.estimateMinutes, language)}</span>
      ) : null}
      {task.attachments.length > 0 && (
        <span>
          <Icon name="paperclip" size={10} />
          {task.attachments.length}
        </span>
      )}
      {task.reminderAt && <Icon name="bell" size={10} />}
      {task.seriesId && <Icon name="repeat" size={10} />}
    </span>
  );
}
