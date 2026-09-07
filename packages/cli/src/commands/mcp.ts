import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  CreateSeriesInput,
  CreateTaskInput,
  ListRemindersQuery,
  ListTasksQuery,
  RUNTIME_VERSION,
  SnoozeInput,
  TodoCueError,
  UpdateTaskInput,
  VersionedAction,
} from "@todocue/shared";
import type { TodoCueClient } from "@todocue/server";

const Id = z.object({ id: z.string().describe("task id, e.g. t_…") });
const IdVersioned = Id.extend({ expectedVersion: z.number().int().optional() });

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (e) {
    const body = e instanceof TodoCueError ? e.toBody() : { error: { code: "INTERNAL", message: (e as Error).message } };
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: true };
  }
}

export function buildMcpServer(getClient: () => TodoCueClient): McpServer {
  const server = new McpServer({ name: "todocue", version: RUNTIME_VERSION });
  const c = getClient;

  server.registerTool(
    "todocue_context",
    {
      title: "Current time context",
      description:
        "Return the runtime's current instant, IANA timezone, local date and weekday. Call this first before computing relative dates like 'tomorrow' or '17:00'.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => run(() => c().context()),
  );
  server.registerTool(
    "todocue_today",
    {
      title: "Today's plan",
      description: "Tasks for today: overdue, due today, scheduled today and carried-over items with reasons, plus tasks completed today.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => run(() => c().today()),
  );
  server.registerTool(
    "todocue_next",
    {
      title: "Next task",
      description: "The single most relevant task to work on now (with reason) and the ordered candidate list. Tasks scheduled for later are excluded.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => run(() => c().next()),
  );
  server.registerTool(
    "todocue_list_tasks",
    {
      title: "List tasks",
      description: "List tasks with filters. Default status is todo. Dates are local YYYY-MM-DD; q searches title/notes.",
      inputSchema: ListTasksQuery,
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => c().listTasks(args)),
  );
  server.registerTool(
    "todocue_get_task",
    { title: "Get task", description: "Get a task with its series and latest reminder.", inputSchema: Id, annotations: { readOnlyHint: true } },
    async ({ id }) => run(() => c().getTask(id)),
  );
  server.registerTool(
    "todocue_create_task",
    {
      title: "Create task",
      description:
        "Create a task. Times: scheduledAt/dueAt/reminderAt accept ISO with offset or local ISO (interpreted in timezone). Use scheduledDate/dueDate for date-only plans. Add repeat {kind:'daily'} or {kind:'weekly',weekdays:[1..7]} (1=Mon) to create a recurring series; then scheduledTime/reminderTime (HH:mm) apply per instance. Pass idempotencyKey to make retries safe.",
      inputSchema: CreateTaskInput.extend({ idempotencyKey: z.string().optional() }),
    },
    async ({ idempotencyKey, ...input }) => run(() => c().createTask(input, idempotencyKey ? { idempotencyKey } : undefined)),
  );
  server.registerTool(
    "todocue_update_task",
    {
      title: "Update task",
      description: "Update fields of a task (null clears a field). For a recurring instance only that instance changes. Pass expectedVersion to detect concurrent edits (VERSION_CONFLICT).",
      inputSchema: UpdateTaskInput.extend({ id: z.string() }),
    },
    async ({ id, ...patch }) => run(() => c().updateTask(id, patch)),
  );
  server.registerTool(
    "todocue_complete_task",
    { title: "Complete task", description: "Mark a task done; pending reminders are cancelled.", inputSchema: IdVersioned },
    async ({ id, ...body }) => run(() => c().completeTask(id, body)),
  );
  server.registerTool(
    "todocue_reopen_task",
    { title: "Reopen task", description: "Reopen a done/cancelled/skipped task (undo). Past reminders are not re-sent.", inputSchema: IdVersioned },
    async ({ id, ...body }) => run(() => c().reopenTask(id, body)),
  );
  server.registerTool(
    "todocue_cancel_task",
    { title: "Cancel task", description: "Cancel a task.", inputSchema: IdVersioned },
    async ({ id, ...body }) => run(() => c().cancelTask(id, body)),
  );
  server.registerTool(
    "todocue_skip_task",
    { title: "Skip occurrence", description: "Skip one instance of a recurring series (series instances only).", inputSchema: IdVersioned },
    async ({ id, ...body }) => run(() => c().skipTask(id, body)),
  );
  server.registerTool(
    "todocue_snooze_task",
    { title: "Snooze reminder", description: "Move only the reminder later: minutes (default 10) or until (instant).", inputSchema: SnoozeInput.extend({ id: z.string() }) },
    async ({ id, ...body }) => run(() => c().snoozeTask(id, body)),
  );
  server.registerTool(
    "todocue_create_series",
    { title: "Create recurring series", description: "Create a daily/weekly series; instances are generated 30 days ahead.", inputSchema: CreateSeriesInput },
    async (input) => run(() => c().createSeries(input)),
  );
  server.registerTool(
    "todocue_list_series",
    { title: "List series", description: "List recurring series (optionally by status).", inputSchema: z.object({ status: z.enum(["active", "stopped"]).optional() }), annotations: { readOnlyHint: true } },
    async ({ status }) => run(() => c().listSeries(status)),
  );
  server.registerTool(
    "todocue_get_series",
    { title: "Get series", description: "Get a series and all its instances.", inputSchema: Id, annotations: { readOnlyHint: true } },
    async ({ id }) => run(() => c().getSeries(id)),
  );
  server.registerTool(
    "todocue_stop_series",
    { title: "Stop series", description: "Stop a series: future instances are cancelled, today's and history kept. To change a rule, stop and create a new series.", inputSchema: IdVersioned },
    async ({ id, ...body }) => run(() => c().stopSeries(id, VersionedAction.parse(body))),
  );
  server.registerTool(
    "todocue_list_reminders",
    { title: "List reminders", description: "Reminders by status: pending, submitted, failed, missed, cancelled.", inputSchema: ListRemindersQuery, annotations: { readOnlyHint: true } },
    async (args) => run(() => c().listReminders(args)),
  );
  server.registerTool(
    "todocue_doctor",
    { title: "Runtime diagnostics", description: "Runtime health: paths, notification authorization, counts and checks.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => run(() => c().doctor()),
  );
  return server;
}

export function serveMcp(getClient: () => TodoCueClient): void {
  serveStdio(() => buildMcpServer(getClient));
}
