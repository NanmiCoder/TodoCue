import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Task } from "@todocue/shared";
import { motionTokens } from "./tokens.js";
import { Icon } from "./icons.js";
import { dateOf } from "./dates.js";
import { TaskMetadata } from "./metadata.js";

export function Mark() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M16.56 16.16 A9 9 0 1 1 16.56 3.84"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="17" cy="10" r="2" fill="currentColor" />
    </svg>
  );
}
export function Gauge({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
  const reduced = useReducedMotion();
  const previous = useRef(completed);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (completed === previous.current + 1) setPulse((value) => value + 1);
    previous.current = completed;
  }, [completed]);
  const progress = Math.min(1, completed / Math.max(total, 1));
  return (
    <svg
      viewBox="0 0 84 84"
      className="gauge"
      role="img"
      aria-label={`${completed}/${total}`}
    >
      {Array.from({ length: 36 }, (_, i) => {
        const angle = (i / 36) * Math.PI * 2 - Math.PI / 2;
        return (
          <circle
            key={i}
            cx={42 + Math.cos(angle) * 38}
            cy={42 + Math.sin(angle) * 38}
            r={i / 36 < progress ? 1.5 : 1.1}
            fill={i / 36 < progress ? "#F26A2E" : "var(--muted)"}
            opacity={i / 36 < progress ? 1 : 0.55}
          />
        );
      })}
      <circle
        cx="42"
        cy="42"
        r="30"
        fill="none"
        stroke="currentColor"
        strokeWidth=".5"
        opacity=".07"
      />
      {progress > 0 && (
        <circle
          cx={42 + 38 * Math.sin(progress * 2 * Math.PI)}
          cy={42 - 38 * Math.cos(progress * 2 * Math.PI)}
          r="3"
          fill="#F26A2E"
        />
      )}
      {pulse > 0 && !reduced && (
        <motion.circle
          key={pulse}
          cx={42 + 38 * Math.sin(progress * 2 * Math.PI)}
          cy={42 - 38 * Math.cos(progress * 2 * Math.PI)}
          r="3"
          fill="none"
          stroke="#F26A2E"
          initial={{ r: 3, opacity: 0.7 }}
          animate={{ r: 12, opacity: 0 }}
          transition={{ duration: 0.7 }}
        />
      )}
      <motion.text
        x="42"
        y="47"
        textAnchor="middle"
        key={completed}
        initial={reduced ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={motionTokens.settle}
      >
        {total ? `${completed}/${total}` : "0"}
      </motion.text>
    </svg>
  );
}
export function TaskRow({
  task,
  disabled,
  onComplete,
  onOpen,
  completingExternal = false,
  group,
  onDrag,
  dragging = false,
  showProject = true,
  today,
}: {
  dragging?: boolean;
  showProject?: boolean;
  today?: string;
  group?: string;
  onDrag?: (
    task: Task,
    event: import("react").PointerEvent<HTMLButtonElement>,
  ) => void;
  completingExternal?: boolean;
  task: Task;
  disabled: boolean;
  onComplete: (task: Task) => Promise<unknown>;
  onOpen: (task: Task) => void;
}) {
  const [completing, setCompleting] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (task.status === "todo") setCompleting(false);
  }, [task.status, task.version]);
  async function finish() {
    if (completing || completingExternal || disabled) return;
    setCompleting(true);
    let success = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, reduced ? 120 : 420));
      const result = await onComplete(task);
      success = result !== false;
    } catch {
      success = false;
    } finally {
      if (!success) setCompleting(false);
    }
  }
  const time =
    task.scheduledAt && dateOf(task.scheduledAt, task.timezone) === today
      ? new Intl.DateTimeFormat(undefined, {
          timeZone: task.timezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(task.scheduledAt))
      : null;
  return (
    <motion.div
      data-task-id={task.id}
      data-group={group}
      layout={!reduced}
      className={`task-row ${completing || completingExternal ? "completing" : ""} ${dragging ? "drag-placeholder" : ""} ${task.status === "done" ? "is-completed" : ""}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
      transition={motionTokens.list}
    >
      {onDrag && (
        <button
          className="drag-handle"
          aria-label={`${document.documentElement.lang === "en" ? "Move" : "拖动"} ${task.title}`}
          disabled={disabled}
          onPointerDown={(event) => onDrag(task, event)}
        >
          <svg viewBox="0 0 10 18" width="10" height="18">
            {[4, 9, 14].flatMap((y) =>
              [3, 7].map((x) => (
                <circle
                  key={`${x}:${y}`}
                  cx={x}
                  cy={y}
                  r="1"
                  fill="currentColor"
                />
              )),
            )}
          </svg>
        </button>
      )}
      <motion.button
        className="check"
        aria-label={`${document.documentElement.lang === "en" ? (task.status === "done" ? "Reopen" : "Complete") : task.status === "done" ? "重新打开" : "完成"} ${task.title}`}
        disabled={disabled || completing || completingExternal}
        onClick={() => void finish()}
        animate={{
          scale:
            (completing || completingExternal) && !reduced
              ? [1, 0.82, 1.16, 1]
              : 1,
        }}
        transition={{ duration: 0.54, times: [0, 0.148, 0.444, 1] }}
      >
        <svg viewBox="0 0 20 20">
          <motion.path
            d="M5 10l3.5 3.5L15 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{
              pathLength:
                completing || completingExternal || task.status === "done"
                  ? 1
                  : 0,
              opacity:
                completing || completingExternal || task.status === "done"
                  ? 1
                  : 0,
            }}
            transition={{
              duration: reduced ? 0 : 0.22,
              delay: reduced ? 0 : 0.06,
              opacity: {
                duration: 0.01,
                delay:
                  completing || completingExternal || task.status === "done"
                    ? reduced
                      ? 0
                      : 0.06
                    : 0,
              },
            }}
          />
        </svg>
      </motion.button>
      <button className="task-text" onClick={() => onOpen(task)}>
        <span className="task-title">{task.title}</span>
        <TaskMetadata
          task={task}
          language={document.documentElement.lang}
          today={today}
          showProject={showProject}
          omitTodayTime
        />
      </button>
      {time && <span className="task-time">{time}</span>}
    </motion.div>
  );
}
