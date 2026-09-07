# TodoCue Local API (v1)

Single-user local HTTP API served by the TodoCue runtime on `127.0.0.1`.
CLI, MCP and the macOS client are all thin clients of this API.

## Connection

- Runtime writes `~/.todocue/connection.json` (mode 0600, honours `TODOCUE_HOME`):
  ```json
  { "baseUrl": "http://127.0.0.1:47831", "token": "<random>", "pid": 123, "startedAt": "…Z", "runtimeVersion": "0.1.1" }
  ```
- Every request except `GET /v1/health` needs `Authorization: Bearer <token>`.
- Default port `47831` (`TODOCUE_PORT` overrides). All routes are under `/v1`.
- JSON bodies; `Content-Type: application/json`.
- Errors: `{ "error": { "code": "...", "message": "...", "details"?: … } }` with codes
  `VALIDATION_ERROR`(400) `UNAUTHORIZED`(401) `NOT_FOUND`(404) `VERSION_CONFLICT`(409)
  `INVALID_STATE`(409) `IDEMPOTENCY_MISMATCH`(422) `UNAVAILABLE`(503) `INTERNAL`(500).
- Writes may send `Idempotency-Key: <string>`; a replay with the same key + same body returns the
  original response, a different body returns `IDEMPOTENCY_MISMATCH`.
- Optimistic concurrency: mutating task/series calls accept `expectedVersion`; a stale value returns
  `VERSION_CONFLICT` with `{ id, expectedVersion, currentVersion }`.

## Time model

- Instants are stored/returned as ISO-8601 UTC (`2026-09-07T01:30:00.000Z`).
- Inputs accept ISO with offset/`Z`, or a local ISO date-time without offset which is interpreted in
  the request `timezone` (default: runtime timezone).
- Date-level fields are `YYYY-MM-DD` local dates. `scheduledDate` xor `scheduledAt`; `dueDate` xor `dueAt`.
- `reminderAt` is always an instant. Every task has exactly one optional reminder.

## Task object

```json
{
  "id": "t_…", "title": "…", "notes": null, "project": null, "priority": "none|low|medium|high",
  "estimateMinutes": null,
  "scheduledDate": "2026-09-07" , "scheduledAt": null,
  "dueDate": null, "dueAt": null, "reminderAt": null,
  "timezone": "Asia/Shanghai",
  "status": "todo|done|cancelled|skipped", "completedAt": null,
  "seriesId": null, "occurrenceDate": null,
  "attachments": [],
  "version": 1, "createdAt": "…Z", "updatedAt": "…Z"
}
```

## Endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/v1/health` | – | `{ ok, runtimeVersion, pid }` (no auth) |
| GET | `/v1/context` | – | `{ now, timezone, today, localNow, weekday, runtimeVersion }` |
| GET | `/v1/tasks` | `status` (repeatable), `project`, `seriesId`, `q`, `from`, `to`, `includeUnscheduled`, `limit` | `{ tasks: Task[] }` (runtime order: overdue → due → scheduled → unscheduled, then priority) |
| POST | `/v1/tasks` | CreateTaskInput (see below) | `201 { task, series? }` |
| GET | `/v1/tasks/:id` | – | `{ task, series?, reminder? }` |
| PATCH | `/v1/tasks/:id` | UpdateTaskInput (`expectedVersion?`, any field; `null` clears) | `{ task }` |
| GET | `/v1/tasks/:id/attachments` | – | `{ attachments: Attachment[] }` |
| POST | `/v1/tasks/:id/attachments` | `{ files: AttachmentUpload[], expectedVersion? }` | `201 { task }` |
| GET | `/v1/tasks/:id/attachments/:attachmentId` | – | `{ attachment, dataBase64 }` |
| GET | `/v1/tasks/:id/attachments/:attachmentId/content` | – | Binary file, authenticated, `no-store`, download disposition |
| DELETE | `/v1/tasks/:id/attachments/:attachmentId` | `{ expectedVersion? }` | `{ task }` |
| POST | `/v1/tasks/:id/complete` | `{ expectedVersion? }` | `{ task }` |
| POST | `/v1/tasks/:id/reopen` | `{ expectedVersion? }` | `{ task }` (undo; past reminders are not re-sent) |
| POST | `/v1/tasks/:id/cancel` | `{ expectedVersion? }` | `{ task }` |
| POST | `/v1/tasks/:id/skip` | `{ expectedVersion? }` | `{ task }` (series instances only) |
| POST | `/v1/tasks/:id/snooze` | `{ expectedVersion?, minutes?: 10, until?: instant }` | `{ task }` (only moves the reminder) |
| GET | `/v1/today` | – | TodayResult |
| GET | `/v1/next` | – | NextResult |
| POST | `/v1/series` | CreateSeriesInput | `201 { series, tasks }` |
| GET | `/v1/series` | `status?` | `{ series: Series[] }` |
| GET | `/v1/series/:id` | – | `{ series, tasks }` |
| POST | `/v1/series/:id/stop` | `{ expectedVersion? }` | `{ series, cancelledTaskIds }` |
| GET | `/v1/reminders` | `status` (repeatable), `taskId`, `limit` | `{ reminders: Reminder[] }` |
| GET | `/v1/events` | SSE, optional `Last-Event-ID` | stream of RuntimeEvent |
| GET | `/v1/export` | – | ExportBundle |
| GET | `/v1/doctor` | – | DoctorReport |
| POST | `/v1/notifications/request-authorization` | – | `{ authorization }` |
| POST | `/v1/notifications/test` | `{ title?, body? }` | `{ ok, channel }` |

### CreateTaskInput

```json
{
  "title": "写周报", "notes": "…", "project": "work", "priority": "high", "estimateMinutes": 30,
  "scheduledDate": "2026-09-08", "scheduledAt": null,
  "dueDate": null, "dueAt": "2026-09-08T18:00:00",
  "reminderAt": "2026-09-08T17:30:00", "timezone": "Asia/Shanghai",
  "repeat": { "kind": "daily" } | { "kind": "weekly", "weekdays": [1,3,5] },
  "scheduledTime": "09:00", "reminderTime": "08:50", "startDate": "2026-09-08", "endDate": null
}
```
When `repeat` is present the runtime creates a Series and returns `{ task: <first instance>, series }`.

### TodayResult

```json
{
  "date": "2026-09-07", "timezone": "…", "now": "…Z", "remaining": 3,
  "items": [ { "task": Task, "reasons": ["overdue"|"due_today"|"scheduled_today"|"carried_over"], "section": "overdue|must|scheduled" } ],
  "completed": [ Task ]
}
```
`items` is ordered by the runtime (section order overdue → must → scheduled, then priority, due, created).
`completed` is tasks completed on the local date (by actual completion time).

### NextResult

```json
{ "now": "…Z", "timezone": "…", "next": { "task": Task, "group": "overdue|due_today|scheduled_reached|unscheduled", "reason": "…" } | null, "candidates": [ … ] }
```
Tasks whose scheduled time has not arrived are excluded.

### Series

```json
{ "id": "s_…", "title": "…", "notes": null, "project": null, "priority": "none", "estimateMinutes": null,
  "rule": { "kind": "daily" } | { "kind": "weekly", "weekdays": [1,2] },
  "scheduledTime": "09:00" | null, "reminderTime": "08:50" | null, "timezone": "…",
  "startDate": "…", "endDate": null, "status": "active|stopped", "stoppedAt": null,
  "generatedThrough": "…", "version": 1, "createdAt": "…Z", "updatedAt": "…Z" }
```
Instances are pre-generated 30 days ahead and topped up on start, day change and queries.
Editing/completing/skipping affects one instance. Stopping cancels instances after today and keeps history.
To change a rule: stop the series and create a new one.

### Reminder

```json
{ "id": "r_…", "taskId": "t_…", "fireAt": "…Z", "status": "pending|submitted|failed|missed|cancelled",
  "attempts": 0, "lastError": null, "submittedAt": null, "channel": "helper|osascript|summary" | null,
  "createdAt": "…Z", "updatedAt": "…Z" }
```

### SSE `/v1/events`

```
id: 42
event: task.updated
data: {"seq":42,"type":"task.updated","at":"…Z","id":"t_…"}
```
Event types: `reminder.fired`, `task.created`, `task.updated`, `series.created`, `series.updated`, `reminder.updated`
(`related.taskId`), `day.changed`, `runtime.started`. A `: ping` comment is sent every 15s.
Clients subscribe first, then load snapshots; on reconnect they must re-sync (`/v1/today`, `/v1/tasks`).

## Notification click → app

The notification helper opens `todocue://task/<taskId>` on click; the macOS app registers the scheme
and reveals the task in the side panel.

## Attachments

Create tasks with `attachments: AttachmentUpload[]`. Patch with `addAttachments` and/or
`removeAttachmentIds`; omitted fields preserve existing attachments. Text edits, removals and uploads
commit in one transaction, increment the task version once and emit `task.updated`. Upload POST/PATCH
supports the usual `Idempotency-Key` and `expectedVersion` semantics.

```json
{
  "title": "整理灵感",
  "attachments": [
    { "name": "idea.png", "mediaType": "image/png", "dataBase64": "<standard padded base64>" },
    { "name": "notes.txt", "mediaType": "text/plain", "dataBase64": "<standard padded base64>" }
  ]
}
```

`mediaType` is optional: common filename extensions are inferred, otherwise `application/octet-stream`.
Filename must be a plain basename, up to 255 characters, without path separators/control characters.
Limits: 20 files per task, 10 MiB per file, 30 MiB total decoded bytes per task. Upload-capable routes
accept up to 42 MiB JSON; other routes retain their 1 MiB limit. Empty files are allowed.

Every task snapshot includes metadata only:

```json
{ "id": "a_…", "taskId": "t_…", "name": "idea.png", "mediaType": "image/png",
  "size": 1234, "sha256": "<64 hex chars>", "createdAt": "…Z" }
```

Bytes are copied into SQLite BLOBs with their metadata; deleting/moving the original file does not
break the attachment. Database backups include them. Schema v1 is backed up before migration to v2.
JSON exports retain `version: 1` and add an `attachments` array of metadata plus `dataBase64`, while
legacy tasks decode with empty attachments. There is no JSON import endpoint.

Attachments on recurring creation belong to the **first instance only**. Add files to later instances
explicitly; series generation never duplicates attachment bytes automatically.

## Reminder Cue events

The scheduler emits `reminder.fired` once per reminder, independently of system notification success:

```json
{ "seq": 43, "type": "reminder.fired", "at": "…Z", "id": "r_…",
  "related": { "taskId": "t_…", "fireAt": "…Z", "count": "1", "late": "false" } }
```

Missed reminders may be grouped (`count > 1`, `late: "true"`); `id` and `taskId` identify the first
current reminder in the group. Notification retries do not emit another Cue. Snoozing creates a new
reminder and can produce a new Cue. The macOS client ignores stale/replayed events, cancelled/completed
or rescheduled tasks, disabled notch UI, and full screen when quiet mode is enabled. App must be running
on a Mac with a notch for a Cue to appear; the background system notification path remains independent.
