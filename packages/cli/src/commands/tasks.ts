import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import type { CreateTaskInput, Priority, UpdateTaskInput } from "@todocue/shared";
import { formatLocal } from "@todocue/engine";
import type { TodoCueClient } from "@todocue/server";
import { formatReminderLine, formatSeriesLine, formatTaskDetail, formatTaskLine, print, whenOf, type OutputOptions } from "../output.js";
import { parseWeekdays, resolveDate, resolveInstant } from "../timeargs.js";

type Ctx = { client: () => TodoCueClient; out: () => OutputOptions };

function timeOptions(cmd: Command): Command {
  return cmd
    .option("-n, --notes <text>", "notes")
    .option("-p, --project <name>", "project")
    .option("-P, --priority <level>", "none|low|medium|high")
    .option("-e, --estimate <minutes>", "estimated minutes")
    .option("-d, --date <date>", "plan date: YYYY-MM-DD | today | tomorrow | +Nd")
    .option("-a, --at <time>", 'plan time: HH:mm | "tomorrow 09:00" | "YYYY-MM-DD HH:mm" | +30m | ISO')
    .option("--due <date>", "due date (same forms as --date)")
    .option("--due-at <time>", "due time (same forms as --at)")
    .option("-r, --remind <time>", "reminder time (same forms as --at)")
    .option("--tz <zone>", "IANA timezone for interpreting local times");
}

export function registerTaskCommands(program: Command, ctx: Ctx): void {
  timeOptions(
    program
      .command("add <title...>")
      .description("create a task (add --repeat for a recurring series)")
      .option("--repeat <rule>", "daily | weekly")
      .option("--weekdays <list>", "for weekly: mon,wed,fri or 1,3,5")
      .option("--time <HH:mm>", "recurring: local time of each instance")
      .option("--remind-time <HH:mm>", "recurring: local reminder time of each instance")
      .option("--start <date>", "recurring: first date")
      .option("--end <date>", "recurring: last date")
      .option("--idempotency-key <key>", "reuse to make retries safe"),
  ).action(async (titleParts: string[], opts) => {
    const client = ctx.client();
    const context = await client.context();
    const input: CreateTaskInput = { title: titleParts.join(" ") };
    if (opts.notes) input.notes = opts.notes;
    if (opts.project) input.project = opts.project;
    if (opts.priority) input.priority = opts.priority as Priority;
    if (opts.estimate) input.estimateMinutes = Number.parseInt(opts.estimate, 10);
    if (opts.date) input.scheduledDate = resolveDate(opts.date, context);
    if (opts.at) input.scheduledAt = resolveInstant(opts.at, context);
    if (opts.due) input.dueDate = resolveDate(opts.due, context);
    if (opts.dueAt) input.dueAt = resolveInstant(opts.dueAt, context);
    if (opts.remind) input.reminderAt = resolveInstant(opts.remind, context);
    if (opts.tz) input.timezone = opts.tz;
    if (opts.repeat) {
      input.repeat = opts.repeat === "weekly" ? { kind: "weekly", weekdays: parseWeekdays(opts.weekdays ?? "") } : { kind: "daily" };
      if (opts.time) input.scheduledTime = opts.time;
      if (opts.remindTime) input.reminderTime = opts.remindTime;
      if (opts.start) input.startDate = resolveDate(opts.start, context);
      if (opts.end) input.endDate = resolveDate(opts.end, context);
    }
    const res = await client.createTask(input, { idempotencyKey: opts.idempotencyKey ?? randomUUID() });
    print(ctx.out(), res, () =>
      res.series ? `created series ${res.series.id}\n${formatSeriesLine(res.series)}\nfirst instance:\n${formatTaskLine(res.task)}` : `created\n${formatTaskLine(res.task)}`,
    );
  });

  program
    .command("list")
    .alias("ls")
    .description("list tasks (open tasks by default)")
    .option("-s, --status <list>", "todo,done,cancelled,skipped (comma separated)")
    .option("-p, --project <name>")
    .option("-q, --query <text>", "search title/notes")
    .option("--series <id>")
    .option("--from <date>")
    .option("--to <date>")
    .option("--all", "all statuses")
    .option("--limit <n>")
    .action(async (opts) => {
      const client = ctx.client();
      const context = await client.context();
      const q: Parameters<TodoCueClient["listTasks"]>[0] = {};
      if (opts.all) q.status = ["todo", "done", "cancelled", "skipped"];
      else if (opts.status) q.status = String(opts.status).split(",") as never;
      if (opts.project) q.project = opts.project;
      if (opts.query) q.q = opts.query;
      if (opts.series) q.seriesId = opts.series;
      if (opts.from) q.from = resolveDate(opts.from, context);
      if (opts.to) q.to = resolveDate(opts.to, context);
      if (opts.limit) q.limit = Number.parseInt(opts.limit, 10);
      const res = await client.listTasks(q);
      print(ctx.out(), res, () => (res.tasks.length ? res.tasks.map((t) => formatTaskLine(t)).join("\n") : "(no tasks)"));
    });

  program
    .command("today")
    .description("today's plan: overdue, due today, scheduled, carried over")
    .action(async () => {
      const res = await ctx.client().today();
      print(ctx.out(), res, () => {
        const lines = [`${res.date} · 剩余 ${res.remaining}`];
        const sections: Record<string, string> = { overdue: "逾期", must: "必须完成", scheduled: "已安排" };
        let current = "";
        for (const item of res.items) {
          if (item.section !== current) {
            current = item.section;
            lines.push(`\n## ${sections[current]}`);
          }
          lines.push(formatTaskLine(item.task, `原因：${item.reasons.join(", ")}`));
        }
        if (res.completed.length) {
          lines.push(`\n## 今日已完成 (${res.completed.length})`);
          for (const t of res.completed) lines.push(formatTaskLine(t));
        }
        return lines.join("\n");
      });
    });

  program
    .command("next")
    .description("the single most relevant task now")
    .option("--all", "show all candidates")
    .action(async (opts) => {
      const res = await ctx.client().next();
      print(ctx.out(), res, () => {
        if (!res.next) return "(nothing to do right now)";
        const list = opts.all ? res.candidates : [res.next];
        return list.map((c) => formatTaskLine(c.task, `${c.group} · ${c.reason}`)).join("\n");
      });
    });

  program
    .command("show <id>")
    .description("show a task")
    .action(async (id: string) => {
      const res = await ctx.client().getTask(id);
      print(ctx.out(), res, () => formatTaskDetail(res.task, res.series, res.reminder));
    });

  timeOptions(
    program
      .command("edit <id>")
      .description("edit fields (use --clear-<field> to unset)")
      .option("-t, --title <title>")
      .option("--clear-schedule")
      .option("--clear-due")
      .option("--clear-remind")
      .option("--clear-project")
      .option("--clear-notes")
      .option("--expect <version>", "expected version"),
  ).action(async (id: string, opts) => {
    const client = ctx.client();
    const context = await client.context();
    const patch: UpdateTaskInput = {};
    if (opts.title) patch.title = opts.title;
    if (opts.notes) patch.notes = opts.notes;
    if (opts.clearNotes) patch.notes = null;
    if (opts.project) patch.project = opts.project;
    if (opts.clearProject) patch.project = null;
    if (opts.priority) patch.priority = opts.priority as Priority;
    if (opts.estimate) patch.estimateMinutes = Number.parseInt(opts.estimate, 10);
    if (opts.date) patch.scheduledDate = resolveDate(opts.date, context);
    if (opts.at) patch.scheduledAt = resolveInstant(opts.at, context);
    if (opts.clearSchedule) {
      patch.scheduledDate = null;
      patch.scheduledAt = null;
    }
    if (opts.due) patch.dueDate = resolveDate(opts.due, context);
    if (opts.dueAt) patch.dueAt = resolveInstant(opts.dueAt, context);
    if (opts.clearDue) {
      patch.dueDate = null;
      patch.dueAt = null;
    }
    if (opts.remind) patch.reminderAt = resolveInstant(opts.remind, context);
    if (opts.clearRemind) patch.reminderAt = null;
    if (opts.tz) patch.timezone = opts.tz;
    if (opts.expect) patch.expectedVersion = Number.parseInt(opts.expect, 10);
    const res = await client.updateTask(id, patch);
    print(ctx.out(), res, () => `updated\n${formatTaskLine(res.task)}`);
  });

  const simple = (name: string, desc: string, fn: (c: TodoCueClient, id: string, v?: number) => Promise<{ task: import("@todocue/shared").Task }>) =>
    program
      .command(`${name} <id>`)
      .description(desc)
      .option("--expect <version>", "expected version")
      .action(async (id: string, opts) => {
        const res = await fn(ctx.client(), id, opts.expect ? Number.parseInt(opts.expect, 10) : undefined);
        print(ctx.out(), res, () => `${name}: ${res.task.status}\n${formatTaskLine(res.task)}`);
      });
  simple("done", "complete a task", (c, id, v) => c.completeTask(id, v ? { expectedVersion: v } : {}));
  simple("reopen", "reopen (undo complete/cancel/skip)", (c, id, v) => c.reopenTask(id, v ? { expectedVersion: v } : {}));
  simple("cancel", "cancel a task", (c, id, v) => c.cancelTask(id, v ? { expectedVersion: v } : {}));
  simple("skip", "skip a recurring instance", (c, id, v) => c.skipTask(id, v ? { expectedVersion: v } : {}));

  program
    .command("snooze <id>")
    .description("move the reminder later (default 10 minutes)")
    .option("-m, --minutes <n>")
    .option("-u, --until <time>", "same forms as --at")
    .action(async (id: string, opts) => {
      const client = ctx.client();
      const body: { minutes?: number; until?: string } = {};
      if (opts.minutes) body.minutes = Number.parseInt(opts.minutes, 10);
      if (opts.until) body.until = resolveInstant(opts.until, await client.context());
      const res = await client.snoozeTask(id, body);
      print(ctx.out(), res, () => `snoozed until ${formatLocal(res.task.reminderAt!, res.task.timezone)}\n${formatTaskLine(res.task)}`);
    });

  const series = program.command("series").description("recurring series");
  series
    .command("list")
    .option("--stopped", "include stopped series")
    .action(async (opts) => {
      const res = await ctx.client().listSeries(opts.stopped ? undefined : "active");
      print(ctx.out(), res, () => (res.series.length ? res.series.map(formatSeriesLine).join("\n") : "(no series)"));
    });
  series.command("show <id>").action(async (id: string) => {
    const res = await ctx.client().getSeries(id);
    print(ctx.out(), res, () => `${formatSeriesLine(res.series)}\n\n${res.tasks.map((t) => `${t.occurrenceDate}  ${t.status.padEnd(9)} ${t.id}  ${whenOf(t)}`).join("\n")}`);
  });
  series
    .command("stop <id>")
    .description("stop a series; future instances are cancelled, history kept")
    .option("--expect <version>")
    .action(async (id: string, opts) => {
      const res = await ctx.client().stopSeries(id, opts.expect ? { expectedVersion: Number.parseInt(opts.expect, 10) } : {});
      print(ctx.out(), res, () => `stopped ${res.series.id}; cancelled ${res.cancelledTaskIds.length} future instance(s)`);
    });

  program
    .command("reminders")
    .description("list reminders")
    .option("-s, --status <list>", "pending,submitted,failed,missed,cancelled")
    .option("--task <id>")
    .action(async (opts) => {
      const client = ctx.client();
      const q: Parameters<TodoCueClient["listReminders"]>[0] = {};
      if (opts.status) q.status = String(opts.status).split(",") as never;
      if (opts.task) q.taskId = opts.task;
      const [res, context] = await Promise.all([client.listReminders(q), client.context()]);
      print(ctx.out(), res, () => (res.reminders.length ? res.reminders.map((r) => formatReminderLine(r, context.timezone)).join("\n") : "(no reminders)"));
    });

  program
    .command("context")
    .description("runtime time/timezone context")
    .action(async () => {
      const res = await ctx.client().context();
      print(ctx.out(), res, () => `now       ${res.localNow} (${res.timezone})\ntoday     ${res.today} (weekday ${res.weekday})\nruntime   ${res.runtimeVersion}`);
    });
}
