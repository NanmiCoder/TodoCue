import { z } from "zod";
import { InstantUtc, IanaTimezone, Task, Series, Reminder, Attachment, OrderingState } from "./schemas.js";
import { PeriodicReminder, PeriodicOccurrence } from "./periodic.js";

export const ExportBundle = z.object({
  format: z.literal("todocue-export"),
  version: z.literal(1),
  exportedAt: InstantUtc,
  timezone: IanaTimezone,
  tasks: z.array(Task),
  series: z.array(Series),
  reminders: z.array(Reminder),
  attachments: z.array(Attachment.extend({ dataBase64: z.string() })).default([]),
  ordering: OrderingState.optional(),
  periodicReminders: z.array(PeriodicReminder).optional(),
  periodicOccurrences: z.array(PeriodicOccurrence).optional(),
});
export type ExportBundle = z.infer<typeof ExportBundle>;
