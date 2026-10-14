import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Board } from "@todocue/client";
import type { ListView, MoveTaskInput, Task } from "@todocue/shared";
export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}
export interface DragProjection {
  task: Task;
  source: string;
  target: string;
  beforeId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}
export function projectGroups(
  groups: TaskGroup[],
  drag: DragProjection | null,
): TaskGroup[] {
  if (!drag) return groups;
  return groups.map((group) => {
    const tasks = group.tasks.filter((task) => task.id !== drag.task.id);
    if (group.key === drag.target) {
      const before = tasks.findIndex((task) => task.id === drag.beforeId);
      tasks.splice(before < 0 ? tasks.length : before, 0, drag.task);
    }
    return { ...group, tasks };
  });
}
export function useTaskDrag({
  board,
  view,
  disabled,
  commit,
  onError,
}: {
  board: Board | null;
  view: ListView;
  disabled: boolean;
  commit: (id: string, input: MoveTaskInput) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [drag, setDrag] = useState<DragProjection | null>(null);
  const frozen = useRef<Board | null>(null);
  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => () => cancelRef.current(), [view, disabled]);
  function begin(
    task: Task,
    group: string,
    event: PointerEvent<HTMLButtonElement>,
  ) {
    if (
      !board ||
      disabled ||
      task.status !== "todo" ||
      event.button !== 0 ||
      frozen.current
    )
      return;
    event.preventDefault();
    const row = event.currentTarget.closest<HTMLElement>("[data-task-id]")!;
    const list =
      row.closest<HTMLElement>(".list-scroll") ??
      row.closest<HTMLElement>(".task-list")!;
    const rect = row.getBoundingClientRect();
    const initialX = event.clientX,
      initialY = event.clientY;
    const offsetX = initialX - rect.left,
      offsetY = initialY - rect.top;
    const snapshot = board;
    let active = false,
      ending = false,
      pointerY = initialY;
    let projection: DragProjection = {
      task,
      source: group,
      target: group,
      beforeId: task.id,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    const slots = [
      ...list.querySelectorAll<HTMLElement>("[data-task-id],[data-drop-group]"),
    ].map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        id: row.dataset.taskId,
        beforeId:
          row.dataset.dropGroup !== undefined
            ? row.dataset.beforeId || null
            : undefined,
        group: row.dataset.dropGroup ?? row.dataset.group!,
        top: rect.top + list.scrollTop,
        bottom: rect.bottom + list.scrollTop,
      };
    });
    const bounds = list.getBoundingClientRect();
    function move(event: globalThis.PointerEvent) {
      if (ending) return;
      pointerY = event.clientY;
      if (
        !active &&
        Math.hypot(event.clientX - initialX, event.clientY - initialY) < 6
      )
        return;
      if (!active) {
        active = true;
        frozen.current = snapshot;
        document.body.dataset.dragging = "true";
      }
      const y = event.clientY + list.scrollTop;
      const target = slots.find(
        (slot) => y >= slot.top - 5 && y <= slot.bottom + 5,
      );
      if (
        target &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right
      ) {
        const sameGroup = slots.filter(
          (slot) => slot.group === target.group && !!slot.id,
        );
        const next = sameGroup[sameGroup.indexOf(target) + 1];
        if (view !== "today" || target.group === group) {
          projection = {
            ...projection,
            target: target.group,
            beforeId:
              target.beforeId !== undefined
                ? target.beforeId
                : y < (target.top + target.bottom) / 2
                  ? (target.id ?? null)
                  : (next?.id ?? null),
          };
        }
      }
      projection = {
        ...projection,
        x: event.clientX - offsetX,
        y: event.clientY - offsetY,
      };
      setDrag(projection);
    }
    function cleanup() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("keydown", key, true);
      clearInterval(scroll);
    }
    function cancel() {
      ending = true;
      cleanup();
      frozen.current = null;
      setDrag(null);
      delete document.body.dataset.dragging;
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    }
    async function end(event: globalThis.PointerEvent) {
      if (ending) return;
      ending = true;
      cleanup();
      if (
        !active ||
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom ||
        projection.beforeId === task.id
      ) {
        cancel();
        return;
      }
      try {
        await commit(task.id, {
          view,
          sourceGroup: group,
          targetGroup: projection.target,
          beforeId: projection.beforeId,
          expectedVersion: task.version,
          expectedRevision: snapshot.ordering.revision,
        });
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        cancel();
      }
    }
    const scroll = setInterval(() => {
      if (!active || ending) return;
      if (pointerY < bounds.top + 30) list.scrollTop -= 7;
      else if (pointerY > bounds.bottom - 30) list.scrollTop += 7;
    }, 16);
    cancelRef.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("keydown", key, true);
  }
  return { drag, frozen: frozen.current, begin };
}
