import type { Task } from "@todocue/shared";

interface BoardLike {
  all: Task[];
  today: { completed: Task[] };
}

/** The freshest copy of a task the panel knows, falling back to the one the caller holds. */
export function latestTask(board: BoardLike | null | undefined, task: Task): Task {
  return (
    board?.all.find((item) => item.id === task.id) ??
    board?.today.completed.find((item) => item.id === task.id) ??
    task
  );
}
