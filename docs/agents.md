# Agent 接入

TodoCue 的三种程序接口共用同一套参数、返回类型和错误码（`packages/shared`）。

## MCP（推荐）

`todocue mcp` 以 stdio 方式启动 MCP 服务器，内部通过 Local API 访问后台运行时，所以多个 Agent 会话共享同一份数据，并且 UI 会在 1 秒内反映变化。

Claude Code：

```bash
claude mcp add todocue -- todocue mcp
# 或未链接 PATH 时
claude mcp add todocue -- node /path/to/TodoCue/packages/cli/dist/index.js mcp
```

Codex / 其他支持 stdio MCP 的客户端：

```json
{ "mcpServers": { "todocue": { "command": "todocue", "args": ["mcp"] } } }
```

工具列表：

| 工具 | 说明 |
|---|---|
| `todocue_context` | 当前时间、时区、今日日期（先调用，再换算“明天 17:00”之类的相对时间） |
| `todocue_today` / `todocue_next` | 今日视图（含原因与分区）/ 下一项及候选列表 |
| `todocue_list_tasks` / `todocue_get_task` | 筛选、查看 |
| `todocue_create_task` | 创建；带 `repeat` 时创建系列；支持 `idempotencyKey` |
| `todocue_update_task` | 修改（`null` 清空字段，`expectedVersion` 做并发检查） |
| `todocue_complete_task` / `reopen` / `cancel` / `skip` / `snooze` | 状态与提醒操作 |
| `todocue_create_series` / `list_series` / `get_series` / `stop_series` | 每日／每周系列 |
| `todocue_list_reminders` | 待发送、已提交、失败、错过、已取消 |
| `todocue_doctor` | 运行时诊断 |

时间输入约定：`scheduledAt` / `dueAt` / `reminderAt` 接受带偏移的 ISO，或不带偏移的本地 ISO（按 `timezone` 解释，默认运行时时区）；日期级字段用 `YYYY-MM-DD`。

## CLI

所有业务命令支持 `--json`，错误输出 `{ "error": { "code", "message", "details" } }` 且退出码为 1。适合脚本或不支持 MCP 的 Agent：

```bash
todocue --json today
todocue --json add "周五提交报销" --due friday-date --remind "tomorrow 09:00" --idempotency-key abc123
```

## Local API

直接使用 HTTP 时读取 `~/.todocue/connection.json` 获取 `baseUrl` 与 `token`，接口见 `docs/api.md`。实时更新用 `GET /v1/events`（SSE）。
