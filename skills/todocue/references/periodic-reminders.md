# Periodic reminders

Use `context` first for the runtime timezone. The title and interval are required. Defaults: all seven days, 09:00–18:00, mode `after_completion`, `followUpMinutes` 10, runtime timezone, enabled. A completed save returns `{ reminder }` with ID, configuration `version`, state `revision`, Chinese `summary`, `state`, `nextFireAt` (UTC) and `currentOccurrence`. Saving a rule is not proof of notification delivery.

“周一、三、六，九点到六点，每半小时提醒起来活动”:

```bash
todocue --json periodic add '起来活动一下' --every 30m --weekdays mon,wed,sat --between 09:00-18:00 --idempotency-key 'UNIQUE_OPERATION_KEY'
```

Generate the operation key before calling. On an uncertain result, preserve both key and exact payload and retry once; do not switch transport or create another rule. Show the returned summary and next local time immediately; an explicit creation request does not need a second confirmation.

“每天每小时提醒喝水，午休不提醒，喝完再重新计时” with hours already specified in the conversation:

```bash
todocue --json periodic add '喝水' --every 1h --between 09:00-12:00 --between 13:00-18:00 --mode after_completion --idempotency-key 'UNIQUE_OPERATION_KEY'
```

- `--every` accepts integer minutes, `30m`, or `1h`; range 1–1440 minutes.
- `--weekdays` accepts day names or numbers 1=Monday through 7=Sunday; weekends can be selected freely.
- Repeat `--between HH:mm-HH:mm` for multiple non-overlapping windows. No overnight windows; `24:00` is allowed only as an end. At least one window must be longer than the interval. The first fixed slot is start + interval; the end is excluded.
- `--mode after_completion` is the default and fits habits (stand up, drink water, rest eyes): the timer counts from when the user finishes, so a cue never arrives a minute after they got up. `--mode fixed` is for clock-aligned times (“on the hour”, “at :30”); its slots are unaffected by completion. Pass `--mode fixed` only when the user asks for fixed clock times.
- `--follow-up <minutes>` (0–120, default 10; `0` = off) applies to `after_completion`: a cue that was shown and ignored is asked again after that many minutes, up to 3 times, then stays on the notch. Map “remind me again if I don’t react” to it. The desktop app also treats 5+ minutes away from the computer as a break and restarts the timer (user setting “Time away counts as a break”); there is no CLI flag for that.
- `--mode after_completion` maps “after I finish / after I confirm, count again”. Without confirmation the card stays on the notch (or folds into its count) and the rule waits, including over lunch. It resets on the next active day. Completion re-arms from the actual confirmation time; if the target is outside a window, the next window starts a full interval later.
- `--tz` explicitly overrides the runtime IANA timezone. Do not invent a timezone from a location guess.
- Sleep/offline reminders are not replayed. The Mac runtime must run; notch cards additionally require the App. System notifications are used when the App cannot claim a notch delivery. A displayed card never times out: it stays until completed, snoozed or paused, and a fixed rule that fires again before that merges into the same row.

## Subsequent actions

Find rules with `periodic list --query '活动'` and read `periodic show RULE_ID`. Use returned IDs; ask which rule only when multiple matches cannot be resolved. Read the current version before a mutation and pass `--expect VERSION`. For a fresh creation request do not silently reuse or change an existing rule merely because the title matches.

| Request | Command after `todocue --json` |
|---|---|
| “改成每小时一次” | `periodic edit RULE_ID --every 1h --expect VERSION --idempotency-key KEY` |
| “以后只周末提醒” | `periodic edit RULE_ID --weekdays sat,sun --expect VERSION --idempotency-key KEY` |
| “今天别提醒了” | `periodic pause-today RULE_ID --expect VERSION --idempotency-key KEY` |
| “先关掉 / 恢复” | `periodic pause RULE_ID ...` / `periodic resume RULE_ID ...` |
| “我已经活动了” | `periodic done RULE_ID --occurrence OCCURRENCE_ID --round ROUND --expect VERSION --idempotency-key KEY` |
| “十分钟后提醒” | `periodic snooze RULE_ID --minutes 10 --occurrence OCCURRENCE_ID --round ROUND --expect VERSION --idempotency-key KEY` |
| “删掉这个提醒” | `periodic remove RULE_ID --expect VERSION --idempotency-key KEY` |
| Inspect recent delivery | `periodic history RULE_ID` |

Completion/snooze target the returned current occurrence and round. An old card cannot change a new configuration. If no delivered current occurrence exists, explain that no current reminder can be completed; do not fake a completion by editing its next time. `resume` also clears today's pause.

`periodic edit` patches only provided fields, cancels the previous current occurrence and recalculates future reminders. On `VERSION_CONFLICT` or `INVALID_STATE`, refresh and reconcile; do not force a stale action. Use the existing Skill error/retry rules.

## MCP and App

Use `todocue_create_periodic_reminder`, `todocue_list_periodic_reminders`, `todocue_get_periodic_reminder`, `todocue_update_periodic_reminder`, and `todocue_periodic_action`. Inputs mirror the Local API: `intervalMinutes`, `weekdays`, `windows: [{start,end}]`, `mode`, `followUpMinutes`, `timezone`, `enabled`, plus `idempotencyKey`; edits/actions accept `expectedVersion`. Action values: `pause`, `resume`, `pause_today`, `complete`, `snooze`, `delete`. Completion/snooze include `occurrenceId` and `round`.

When the user asks to see a rule, open `todocue://periodic/RULE_ID` using the existing App entrypoint. It opens the management page and highlights that rule. The user can create through Movement/Eyes/Water/Custom templates (each fills a suitable interval, timing and follow-up) and editable interval/day/window options, without installing or configuring a model.
