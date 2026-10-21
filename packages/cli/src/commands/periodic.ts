import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { TodoCueError, type CreatePeriodicReminderInput, type UpdatePeriodicReminderInput, type PeriodicReminder, type PeriodicWindow, type PeriodicActionInput } from "@todocue/shared";
import { formatLocal } from "@todocue/engine";
import type { TodoCueClient } from "@todocue/server";
import { parseWeekdays } from "../timeargs.js";
import { print, type OutputOptions } from "../output.js";

export function parsePeriodicInterval(value: string): number {
  const match = /^(\d+)(m|h)?$/.exec(value);
  if (!match) throw TodoCueError.validation("间隔使用分钟或小时，例如 30、30m、1h");
  return Number(match[1]) * (match[2] === "h" ? 60 : 1);
}
export function parsePeriodicWindows(values: string[]): PeriodicWindow[] {
  return values.map((value) => {
    const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value);
    if (!match) throw TodoCueError.validation("时段使用 HH:mm-HH:mm，例如 09:00-18:00");
    return { start: match[1]!, end: match[2]! };
  });
}
function describe(rule: PeriodicReminder): string {
  const state = rule.state === "waiting" ? "等待确认" : rule.state === "paused_today" ? "今天暂停" : rule.state === "paused" ? "已暂停"
    : rule.nextFireAt ? `下一次 ${formatLocal(rule.nextFireAt, rule.timezone)}` : "暂无下一次提醒";
  return `${rule.id}  ${rule.title}\n  ${rule.summary}\n  ${state} (${rule.timezone}) · v${rule.version}`;
}
function options(command: Command, requireInterval = false): Command {
  const interval = requireInterval ? command.requiredOption("--every <interval>", "interval: 30, 30m, 1h")
    : command.option("--every <interval>", "interval: 30, 30m, 1h");
  return interval
    .option("--weekdays <days>", "mon,wed,sat or 1,3,6; default every day")
    .option("--between <range>", "HH:mm-HH:mm; repeat for multiple windows; default 09:00-18:00", (value: string, previous: string[]) => [...previous, value], [])
    .option("--mode <mode>", "after_completion (default: the timer restarts when you complete) | fixed (clock-aligned times)")
    .option("--follow-up <minutes>", "after_completion: re-ask this many minutes after an unanswered cue, up to 3 times; 0 = off (default 10)")
    .option("--tz <timezone>", "IANA timezone (default runtime timezone)")
    .option("--idempotency-key <key>", "preserve this key and payload on retry");
}
type Options = { every?: string; weekdays?: string; between: string[]; mode?: "fixed" | "after_completion"; followUp?: string; tz?: string; idempotencyKey?: string; expect?: string; title?: string };
function patch(opts: Options): UpdatePeriodicReminderInput {
  return { ...(opts.every !== undefined ? { intervalMinutes: parsePeriodicInterval(opts.every) } : {}),
    ...(opts.weekdays !== undefined ? { weekdays: parseWeekdays(opts.weekdays) } : {}),
    ...(opts.between.length ? { windows: parsePeriodicWindows(opts.between) } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.followUp !== undefined ? { followUpMinutes: Number(opts.followUp) } : {}), ...(opts.tz !== undefined ? { timezone: opts.tz } : {}),
    ...(opts.expect !== undefined ? { expectedVersion: Number(opts.expect) } : {}) };
}
export function registerPeriodicCommands(program: Command, ctx: { client: () => TodoCueClient; out: () => OutputOptions }): void {
  const group = program.command("periodic").description("interval reminders, separate from tasks and Apple calendars");
  options(group.command("add <title...>").description("create an enabled rule in one call"), true)
    .action(async (title: string[], opts: Options) => {
      const input = { ...patch(opts), title: title.join(" ") } as CreatePeriodicReminderInput;
      const result = await ctx.client().createPeriodicReminder(input, { idempotencyKey: opts.idempotencyKey ?? randomUUID() });
      print(ctx.out(), result, () => describe(result.reminder));
    });
  group.command("list").option("-q, --query <text>").action(async (opts: { query?: string }) => {
    const result = await ctx.client().listPeriodicReminders(opts.query);
    print(ctx.out(), result, () => result.reminders.map(describe).join("\n\n") || "没有周期提醒");
  });
  group.command("show <id>").action(async (id: string) => {
    const result = await ctx.client().getPeriodicReminder(id); print(ctx.out(), result, () => describe(result.reminder));
  });
  group.command("history <id>").action(async (id: string) => {
    const result = await ctx.client().periodicOccurrences(id);
    print(ctx.out(), result, () => result.occurrences.map((r) => `${r.id}  ${r.fireAt}  ${r.delivery} / ${r.result}`).join("\n"));
  });
  options(group.command("edit <id>")).option("--title <title>").option("--expect <version>").action(async (id: string, opts: Options) => {
    const input = { ...patch(opts), ...(opts.title !== undefined ? { title: opts.title } : {}) };
    const result = await ctx.client().updatePeriodicReminder(id, input, { idempotencyKey: opts.idempotencyKey ?? randomUUID() });
    print(ctx.out(), result, () => describe(result.reminder));
  });
  for (const [name, action] of [["pause", "pause"], ["resume", "resume"], ["pause-today", "pause_today"], ["done", "complete"], ["snooze", "snooze"], ["remove", "delete"]] as const) {
    group.command(`${name} <id>`).option("--expect <version>").option("--occurrence <id>", "current occurrence ID")
      .option("--round <number>", "delivery round").option("--minutes <number>", "snooze interval; default 10")
      .option("--idempotency-key <key>").action(async (id: string, opts: { expect?: string; occurrence?: string; round?: string; minutes?: string; idempotencyKey?: string }) => {
        const input: PeriodicActionInput = { action, ...(opts.expect ? { expectedVersion: Number(opts.expect) } : {}),
          ...(opts.occurrence ? { occurrenceId: opts.occurrence } : {}), ...(opts.round ? { round: Number(opts.round) } : {}),
          ...(opts.minutes ? { minutes: Number(opts.minutes) } : {}) };
        const result = await ctx.client().periodicAction(id, input, { idempotencyKey: opts.idempotencyKey ?? randomUUID() });
        print(ctx.out(), result, () => result.reminder ? describe(result.reminder) : `已删除 ${id}`);
      });
  }
}
