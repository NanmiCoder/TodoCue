# TodoCue

本地任务运行时 + macOS 桌面体验。人通过刘海快览和右侧悬浮面板管理任务，Agent 通过 CLI、MCP 和 Local API 操作同一份数据。

```
macOS UI / CLI / MCP  →  Local API (127.0.0.1, token)  →  Task Engine  →  SQLite (~/.todocue)
```

## 目录

| 路径 | 内容 |
|---|---|
| `packages/shared` | Zod 契约：实体、输入、查询结果、事件、错误码（三种接口共用） |
| `packages/engine` | Task Engine：规则、today/next 排序、重复实例、提醒调度、SQLite 迁移与备份 |
| `packages/server` | Fastify Local API（令牌认证、幂等、SSE `/v1/events`）、运行时引导、HTTP 客户端 |
| `packages/cli` | `todocue` CLI（任务命令、`serve`、`service`、`install`、`doctor`、`export`、`mcp`） |
| `apps/macos` | SwiftUI + AppKit 客户端 `TodoCue.app` 与通知辅助程序 `TodoCueNotifier.app` |
| `docs/` | `PLAN.md`（原始计划）、`implementation-plan.md`（实施计划与验收）、`api.md`（接口契约）、`agents.md`（Agent 接入） |

## 快速开始

要求：macOS 14+，Node 24+（已在 Node 26 验证），Xcode 26 / Swift 6 命令行工具。

```bash
npm install
npm run build              # TypeScript 各包
npm run macos:build        # 生成 apps/macos/build/TodoCue.app 与 TodoCueNotifier.app
node packages/cli/dist/index.js install
```

`todocue install` 会：创建 `~/.todocue`、把辅助程序复制到 `~/.todocue/bin`、把 `TodoCue.app` 装到 `~/Applications`、写入 `~/.todocue/bin/todocue` 命令并尝试链接到 `/opt/homebrew/bin`、安装并启动 LaunchAgent `com.todocue.runtime`、请求通知授权。之后打开 `~/Applications/TodoCue.app`。

日常：

```bash
todocue add 写周报 -P high --due today --remind 17:30 -p work -e 30
todocue add 晨跑 --repeat daily --time 06:30 --remind-time 06:00 --start tomorrow
todocue add 健身 --repeat weekly --weekdays mon,wed,fri --time 19:00
todocue today          # 逾期 / 必须完成 / 已安排 + 今日完成
todocue next           # 现在最该做的一项及原因
todocue done <id> / snooze <id> -m 15 / edit <id> -d tomorrow / skip <id> / series stop <id>
todocue doctor         # 安装、运行时、通知授权、失败提醒
todocue export -o backup.json
todocue --json ...     # 所有业务命令支持 JSON 输出
```

开发时不装服务：`npm run dev:serve`（前台运行时），`TODOCUE_HOME=/tmp/x` 可隔离数据。

## 运行时行为

- 数据在 `~/.todocue`（可用 `TODOCUE_HOME` 覆盖）：`todocue.sqlite`（WAL）、`token`、`connection.json`（0600）、`logs/`、`backups/`（迁移前自动 `VACUUM INTO` 备份）。
- 端口默认 `47831`（`TODOCUE_PORT`），只监听 `127.0.0.1`；所有接口除 `/v1/health` 都需要 `Authorization: Bearer <token>`。
- 时区首次启动时读取系统并持久化（`TODOCUE_TZ` 可覆盖）；具体时刻以 UTC 保存并保留 IANA 时区，日期级计划保留日期精度。
- 重复系列预生成未来 30 天实例，在启动、跨日和查询时补齐；停止系列取消今天之后的实例并保留历史。
- 提醒持久化在 `reminders` 表；调度器每 5 秒检查，发送前核对任务最新状态；失败重试 3 次；启动或睡眠恢复后 2 分钟外的提醒作为“错过”处理，多条合并成一条摘要通知。
- 通知通过 `TodoCueNotifier.app`（UNUserNotificationCenter）提交，点击通知打开 `todocue://task/<id>` 定位到面板中的任务；辅助程序缺失时降级为 `osascript` 通知。

## 测试

```bash
npm test                     # vitest：引擎（可控时钟 + 内存库）、API、CLI
cd apps/macos && swift test  # TodoCueKit 解码 / SSE 解析
```

## Agent 接入

见 `docs/agents.md`。简版：在 Claude Code 中 `claude mcp add todocue -- todocue mcp`。
