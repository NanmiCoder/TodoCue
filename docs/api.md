# TodoCue Local API (v1)

Single-user local HTTP API served by the TodoCue runtime on `127.0.0.1`.
CLI, MCP, the native macOS client and the shared desktop preview are thin clients of this API. `packages/client` provides a browser-compatible typed client; the desktop host proxies authentication and SSE.

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
| DELETE | `/v1/tasks/:id` | `{ expectedVersion? }` | `{ deleted: true, task }` — permanent: the task (any status), its reminders and attachments are removed; `task` is its last state. A series instance is just gone and is never re-generated. A repeat call is `NOT_FOUND` |
| POST | `/v1/tasks/:id/complete` | `{ expectedVersion? }` | `{ task }` |
| POST | `/v1/tasks/:id/reopen` | `{ expectedVersion? }` | `{ task }` (undo; past reminders are not re-sent) |
| POST | `/v1/tasks/:id/cancel` | `{ expectedVersion? }` | `{ task }` (keeps the task in history and reopenable; use `DELETE` to erase it) |
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
| POST | `/v1/reminders/retry-failed` | – | `{ requeued }` — 把最近 24 小时内投递失败的提醒重新放回队列 |
| POST | `/v1/notifications/request-authorization` | – | `{ authorization, available, detail, needsSystemSettings, requeued }` |
| POST | `/v1/notifications/open-settings` | – | `{ ok, url }` |
| POST | `/v1/notifications/test` | `{ title?, body? }` | `{ ok, channel }` |

`request-authorization` 只在 macOS 尚未记录过决定时才会真正弹出系统授权窗。一旦用户做过选择（无论允许或
拒绝），`needsSystemSettings` 为 `true`，表示系统不会再询问，必须由用户到「系统设置 › 通知」里手动开启；
此时调用 `open-settings` 可直接打开该面板并定位到 TodoCueNotifier。`open-settings` 的 `ok` 为 `false`
表示打开失败（例如运行环境没有 GUI 会话），调用方应退回到显示手动操作路径的文案。
授权变为 `authorized`/`provisional` 时，`request-authorization` 会把最近 24 小时内失败的提醒重新入队，数量放在
`requeued`；`reminders/retry-failed` 做同样的事，供用户在修好通知设置后手动触发。

### 提醒投递语义

`status: "submitted"` 只表示通知已**提交给系统**，不保证用户看到（专注模式、通知样式为「无」等无法被检测到）。
投递失败时提醒保持 `pending` 并按退避重试：30 秒、2 分钟、5 分钟、之后每 15 分钟一次，直到提醒时间后满 24 小时
才变为 `failed`。恢复后迟到的提醒标题带「错过的提醒」，状态为 `missed`（超过 2 分钟）或 `submitted`。runtime
启动、检测到睡眠唤醒、授权恢复时，最近 24 小时内的 `failed` 提醒会再次入队。已经提交过的提醒，不会因为之后
编辑无关字段（标题、备注等）而重复发送；只有提醒时间本身改变才会生成新的提醒。

`GET /v1/doctor` 的 `notifier` 另含可选字段：`alertStyle`（macOS：`none|banner|alert`）、`visible`（授权了但系统不会
显示时为 `false`）、`degraded`（helper 缺失，走 osascript 降级通道）、`registered`（Windows：toast 的
AppUserModelID 已注册）。顶层的可选 `reminders` 给出 `failed`（只统计最近 24 小时内的失败，即重发还有意义的那些；更早的仍可用 `GET /v1/reminders?status=failed` 查看）、`retrying`、`overduePending`、`lastError`、
`lastTickAt`；`checks` 里的 `reminderDelivery` 在调度器超过 60 秒没有运行时为 `error`。

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
  "attempts": 0, "lastError": null, "submittedAt": null, "channel": "helper|osascript|summary:<channel>" | null,
  "createdAt": "…Z", "updatedAt": "…Z" }
```

### SSE `/v1/events`

```
id: 42
event: task.updated
data: {"seq":42,"type":"task.updated","at":"…Z","id":"t_…"}
```
Event types: `reminder.fired`, `task.created`, `task.updated`, `task.deleted` (`id` is the removed task;
`related.seriesId` when it was a series instance), `series.created`, `series.updated`, `reminder.updated`
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

## Periodic reminders

Interval reminders are independent of tasks/series: no task per trigger, no calendar projection and no Apple Calendar/Reminders synchronization. Create in **one call**:

```json
{ "title": "起来活动一下", "intervalMinutes": 30 }
```

Only those two fields are required. Defaults: `weekdays: [1,2,3,4,5,6,7]`, `windows: [{"start":"09:00","end":"18:00"}]`, `mode: "after_completion"`, `followUpMinutes: 10`, runtime IANA `timezone`, `enabled: true`. The UI uses the same defaults. (Before v0.9 the default mode was `fixed`; rules already saved keep the mode they were saved with, and rules saved before `followUpMinutes` existed read as 10.) `followUpMinutes` is an integer 0–120 and only matters for `after_completion`; `0` turns follow-ups off. Windows are shared across all selected weekdays. Intervals are integer minutes, 1–1440; windows cannot overlap or cross midnight; `24:00` is an end-only value. At least one window must be longer than the interval. Days/windows are normalized into ascending order.

| Method | Path | Input | Result |
|---|---|---|---|
| POST | `/v1/periodic-reminders/preview` | Create input | `{ config, summary, nextFireAt }`, no writes |
| POST | `/v1/periodic-reminders` | Create input; `Idempotency-Key` | `201 { reminder }` |
| GET | `/v1/periodic-reminders` | Optional `q` title filter | `{ reminders }` |
| GET | `/v1/periodic-reminders/:id` | — | `{ reminder }` |
| PATCH | `/v1/periodic-reminders/:id` | Provided config fields, `expectedVersion?` | `{ reminder }` |
| POST | `/v1/periodic-reminders/away` | `{ minutes }` (integer 3–1440) | `{ reset: [ruleId…] }` |
| POST | `/v1/periodic-reminders/:id/action` | `{ action, expectedVersion?, occurrenceId?, round?, minutes? }` | `{ reminder }` or `{ deleted: true, id }` |
| GET | `/v1/periodic-reminders/:id/occurrences` | — | `{ occurrences }`, most recent 200 |

Actions: `pause`, `resume` (also clears today's pause), `pause_today`, `complete`, `snooze` (default 10 minutes), `delete`. Use the current `occurrenceId` and `round` when completing/snoozing. The configuration version changes on edits/pause/resume; scheduled delivery and user completion do not increment it. Mutations accept the existing idempotency header; stale versions return `VERSION_CONFLICT`, stale instances/rounds `INVALID_STATE`. Field validation returns the existing structured error details.

A reminder includes normalized configuration, `id`, configuration `version`, state `revision`, `createdAt`, `updatedAt`, `pausedOn`, `stateDate`, `nextFireAt` (UTC or null), `currentOccurrenceId`, `currentOccurrence`, Chinese `summary` and `state` (`scheduled`, `waiting`, `paused_today`, `paused`). `revision` increases with every persisted rule or occurrence state change, including channel selection and receipts, even when the clock has not advanced. Clients reject older revisions within a configuration version and discard list requests overtaken by an authoritative mutation response. Older saved rules without this additive field read as revision 0. A current occurrence records `ruleVersion`, original `scheduledAt`, effective `fireAt`, delivery `round`, `followUps` (unanswered re-asks of this occurrence; reset by a snooze), `snoozes` (snoozes the user chose; never reset; `round` counts both),  `handledVia` (`"user"` or `"away"` on a completed occurrence; absent on older records), `delivery`, `channel`, `result`, timestamps and `lastError`. Delivery is separate from completion: `displayed` means the App acknowledged its card, `submitted` means submitted to the notification system; neither proves the user completed the action. A claim still in flight can transiently appear as `waiting`; UI completion is available once displayed/submitted.

`fixed` slots are anchored separately to each window: first at start + interval, ending strictly before the end. Completing does not shift the grid. `after_completion` waits for confirmation; completion re-arms from confirmation + interval. Creation/resume inside a window starts from now; a target outside a window moves to the next window's start + a full interval. Waiting survives breaks within the day but resets on the next selected local date. Follow-up (`after_completion` only): when a cue has been shown (`displayed`/`submitted`) and `followUpMinutes` pass inside an active window with no answer, the runtime offers the **same occurrence** again as the next `round` and increments its `followUps`, at most 3 times; after that the occurrence simply stays pending (`state: "waiting"`). A snooze counts as an answer and resets `followUps` to 0. A startup/wake pass restarts the wait before the next follow-up (time the machine was off is not time the cue was ignored); `scheduledAt`, and so the overdue time, is untouched. Snooze keeps the same occurrence with a new round; a fixed snooze reaching the next grid slot merges into that slot. Snooze outside active hours or beyond the occurrence's local date is not sent; rolling reminders keep waiting. Pauses and edits invalidate old instances.

Runtime checks every five seconds. Startup/wake skips missed periodic reminders, with no catch-up notifications. A rolling timer that missed an undelivered occurrence starts from recovery time; an already delivered waiting occurrence persists within its active day. Nonexistent DST wall-clock slots are skipped, fixed folded slots fire only at their first occurrence. Rolling intervals use elapsed time within actual active UTC segments; a nonexistent window boundary does not discard its valid portion, and a fold that leaves the window restarts the interval at the next active segment. Rules retain their IANA timezone when the system zone changes.

### Away from the computer

`POST /v1/periodic-reminders/away` with `{ "minutes": n }` reports that the user was away from the computer for `n` minutes (the desktop host sends it when they come back after at least five minutes without input, or after the machine slept; it reads only the time since the last input). For every enabled `after_completion` rule that is active now and not paused today, a pending occurrence is closed as `completed` with `handledVia: "away"` and `nextFireAt` is recomputed from now, so the next cue is one full interval after the user sat down again. `fixed` rules, paused/disabled rules and rules outside their window are untouched. Reports shorter than three minutes are rejected (`400`). The call is not idempotent-keyed; repeating it only restarts the timer again. The user can turn the host-side reporting off with the `awayCountsAsBreak` desktop setting.

### Internal notch delivery

`periodic.fired` SSE includes the rule ID plus `related.occurrenceId` and `related.round`; `periodic.created` and `periodic.updated` refresh the management view without triggering task/calendar sync.

- `POST /v1/periodic-reminders/:id/claim`: `{ occurrenceId, round, token }`. Atomically selects notch delivery within three seconds of the offer, and accepts retries with the same token. Claim only when the App can display immediately on the pointer's current screen.
- `POST /v1/periodic-reminders/:id/receipt`: same fields plus `displayed: boolean`. Records actual display separately from user completion. A claimed card with no receipt after ten seconds is failed, without system fallback.
- Displaying is not answering. The App keeps a `displayed` occurrence whose `result` is still `pending` on the notch until it is completed, snoozed, paused, replaced by the rule's next occurrence or invalidated; there is no display timeout and no API action for "dismissed". Folding the cards into the notch's count changes nothing here.
- If no App claims within three seconds, the next scheduler pass selects a silent system notification. Selection and replay guards prevent competing channels. Each actual asynchronous system delivery rechecks active hours; an unsent occurrence that has left its window is marked missed and re-armed. A crash after channel selection may lose that occurrence; it never triggers catch-up delivery through a second channel.

Finished instance records are retained for 30 days; the current waiting/diagnostic record is retained. JSON exports include additive `periodicReminders` and `periodicOccurrences` arrays. Deleting a rule removes its instances.


## Cross-platform desktop preview

The `/v1` endpoints, SQLite format and CLI JSON shapes remain compatible. The Rust host reads the local connection file, restricts requests to its authenticated loopback API, and forwards parsed SSE events; the WebView receives task data but never the token. The portable client adds board, move/reset/undo and periodic claim/receipt/preview methods for existing endpoints.

On Windows, notification authorization reports the current system setting. Disabled notifications require the user to enable TodoCue in Settings; `request-authorization` does not pretend to present a macOS permission prompt. Notifications use `todocue://task/<id>?home=<registered-id>` and `todocue://periodic/<id>?home=<registered-id>`. The opaque directory identifier resolves through current-user installation records, never carries a token or a raw path, and must belong to the receiving installation. Unknown identifiers are rejected instead of opening the default data directory. Cold-launch targets wait for the renderer and local runtime before being consumed; warm launches are scoped to the same data directory. Legacy targets without the query continue to open the current installation's remembered directory. The standalone background service and notifier do not depend on the UI process.

[Migration and acceptance status](desktop-migration.md) records which behaviors are locally verified and which require Windows hardware.
