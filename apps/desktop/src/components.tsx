import { useReducedMotion } from "./useReducedMotion.js";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent } from "motion/react";
import type { Task } from "@todocue/shared";
import { motionTokens } from "./tokens.js";
import { checkPress, pulse as pulseRing } from "./motionKit.js";
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
export function Numeral({ value }: { value: number }) {
  const previous = useRef(value);
  const direction = value >= previous.current ? 1 : -1;
  useEffect(() => { previous.current = value; }, [value]);
  return <Rolling text={String(value)} direction={direction} />;
}
/** Characters roll vertically like numericText; tabular figures keep the columns still on any font. */
export function Rolling({ text, direction, className = "" }: { text: string; direction: number; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <span className={`numeral ${className}`}>
      <span className="sr-only">{text}</span>
      {text.split("").map((digit, index) => (
        <span className="numeral-digit" aria-hidden="true" key={text.length - index}>
          <AnimatePresence initial={false} custom={direction}>
            <motion.span key={digit} custom={direction}
              variants={{
                enter: (direction: number) => ({ y: reduced ? 0 : `${direction * 45}%`, opacity: 0 }),
                exit: (direction: number) => ({ y: reduced ? 0 : `${-direction * 45}%`, opacity: 0 }),
              }}
              initial="enter" animate={{ y: 0, opacity: 1 }} exit="exit"
              transition={reduced ? { duration: 0.12 } : motionTokens.settle}
            >{digit}</motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}
export function Gauge({
  completed,
  total,
  showsLabel = true,
  diameter = 84,
  ready = true,
}: {
  completed: number;
  total: number;
  showsLabel?: boolean;
  diameter?: number;
  ready?: boolean;
}) {
  const reduced = useReducedMotion();
  const previous = useRef<number | null>(ready ? completed : null);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!ready) { previous.current = null; return; }
    if (previous.current !== null && completed === previous.current + 1) setPulse((value) => value + 1);
    previous.current = completed;
  }, [completed, ready]);
  const progress = Math.min(1, completed / Math.max(total, 1));
  const shownCompleted = useRef(completed);
  const labelDirection = completed >= shownCompleted.current ? 1 : -1;
  useEffect(() => { shownCompleted.current = completed; }, [completed]);
  const progressValue = useMotionValue(progress);
  const [shownProgress, setShownProgress] = useState(progress);
  useMotionValueEvent(progressValue, "change", setShownProgress);
  useEffect(() => {
    if (reduced || !ready) { progressValue.set(progress); return; }
    const playback = animate(progressValue, progress, motionTokens.settle);
    return () => playback.stop();
  }, [progress, reduced, ready, progressValue]);
  const faceProgress = Math.max(0, Math.min(1, shownProgress));
  const center = diameter / 2;
  const radius = center - 4;
  const dots = Math.max(24, Math.floor(diameter / 2.3));
  return (
    <svg
      viewBox={`0 0 ${diameter} ${diameter}`}
      style={{ width: diameter, height: diameter }}
      className="gauge"
      role="img"
      aria-label={`${completed}/${total}`}
    >
      {Array.from({ length: dots }, (_, i) => {
        const angle = (i / dots) * Math.PI * 2 - Math.PI / 2;
        return (
          <circle
            key={i}
            cx={center + Math.cos(angle) * radius}
            cy={center + Math.sin(angle) * radius}
            r={i / dots < faceProgress ? 1.5 : 1.1}
            fill={i / dots < faceProgress ? "#F26A2E" : "var(--muted)"}
            opacity={i / dots < faceProgress ? 1 : 0.55}
          />
        );
      })}
      <circle
        cx={center}
        cy={center}
        r={Math.max(0, radius - 8)}
        fill="none"
        stroke="currentColor"
        strokeWidth=".5"
        opacity=".07"
      />
      {faceProgress > 0 && (
        <circle
          className="gauge-tip"
          cx={center + radius * Math.sin(faceProgress * 2 * Math.PI)}
          cy={center - radius * Math.cos(faceProgress * 2 * Math.PI)}
          r="3"
          fill="#F26A2E"
        />
      )}
      {pulse > 0 && !reduced && (
        <motion.circle
          key={pulse}
          cx={center + radius * Math.sin(progress * 2 * Math.PI)}
          cy={center - radius * Math.cos(progress * 2 * Math.PI)}
          r="3"
          fill="none"
          stroke="#F26A2E"
          initial={{ r: pulseRing.from, opacity: pulseRing.opacity }}
          animate={{ r: pulseRing.to, opacity: 0 }}
          transition={{ duration: pulseRing.duration, ease: "linear" }}
        />
      )}
      {showsLabel && (
        <foreignObject x="0" y="0" width={diameter} height={diameter}>
          <div className="gauge-label" style={{ fontSize: diameter * 0.16, paddingTop: diameter * 0.04 }}>
            <Rolling text={total ? `${completed}/${total}` : "0"} direction={labelDirection} />
          </div>
        </foreignObject>
      )}
    </svg>
  );
}
export function TaskRow({
  ref,
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
  trailingActions,
}: {
  /** Forwarded so AnimatePresence popLayout can lift a leaving row out of the flow. */
  ref?: Ref<HTMLDivElement>;
  trailingActions?: ReactNode;
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
      ref={ref}
      data-task-id={task.id}
      data-group={group}
      layout={!reduced}
      className={`task-row ${completing || completingExternal ? "completing" : ""} ${dragging ? "drag-placeholder" : ""} ${task.status === "done" ? "is-completed" : ""}`}
      // A row arrives from 6pt above and leaves 6% smaller towards its leading edge while the
      // neighbours close ranks (critically damped, so the list never wobbles).
      initial={{ opacity: 0, y: reduced ? 0 : -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.94 }}
      style={{ originX: 0 }}
      // While a row is being dragged the others yield on a short 0.2s curve (Theme.dragShift).
      transition={reduced ? { duration: 0.12 } : document.body.dataset.dragging === "true"
        ? { default: motionTokens.list, layout: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] } }
        : motionTokens.list}
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
              ? checkPress.values
              : 1,
        }}
        whileHover={
          reduced || completing || completingExternal || task.status === "done"
            ? undefined
            : { scale: 1.06, transition: motionTokens.snap }
        }
        transition={reduced ? { duration: 0.12 } : { duration: checkPress.duration, times: checkPress.times, ease: ["easeOut", "easeOut", "easeInOut"] }}
      >
        <motion.i
          className="check-fill"
          aria-hidden="true"
          initial={false}
          animate={{
            scale: completing || completingExternal || task.status === "done" ? 1 : 0.2,
            opacity: completing || completingExternal || task.status === "done" ? 1 : 0,
          }}
          transition={reduced ? { duration: 0.12 } : motionTokens.pop}
        />
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
              ease: "easeOut",
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
      {trailingActions ? (
        <div className="task-trailing">
          <span className="task-time">{time}</span>
          <div className="task-row-actions">{trailingActions}</div>
        </div>
      ) : time && <span className="task-time">{time}</span>}
    </motion.div>
  );
}
