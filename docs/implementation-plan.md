# TodoCue v0.1 实施计划与现状

本文档是 `PLAN.md` 的落地版本：记录实际架构、实施顺序、验收情况与已知限制。接口契约见 `api.md`，Agent 接入见 `agents.md`。

## 1. 交付范围（已实现）

- 独立 TypeScript / Node.js Task Runtime（npm workspaces：`shared` / `engine` / `server` / `cli`）。
- SwiftUI + AppKit macOS 客户端（刘海快览 + 右侧悬浮面板 + 菜单栏常驻）和独立通知辅助程序。
- 单次任务、每日／每周重复系列、持久化提醒与系统通知。
- 图形界面的添加、编辑、完成、撤销、改期、稍后提醒、跳过、停止系列。
- CLI（业务命令 `--json`）、MCP（官方 TypeScript SDK v2，`todocue mcp`）、Local API（Fastify，SSE）。
- 本机安装（`todocue install`）、LaunchAgent 后台运行、`doctor` 诊断、JSON 导出。

未包含（与计划一致）：内置 AI 聊天、日历联动、自动排程、云同步、公开分发安装包。

## 2. 架构

```
TodoCue.app (SwiftUI/AppKit) ─┐
todocue CLI ──────────────────┼─ HTTP 127.0.0.1:47831 + Bearer token ─ Fastify ─ TaskEngine ─ SQLite (WAL)
todocue mcp (stdio) ──────────┘                                            │
TodoCueNotifier.app ◄──────────── 调度器 execFile ────────────────────────┘
```

| 组件 | 位置 | 说明 |
|---|---|---|
| 契约 | `packages/shared/src/schemas.ts`, `errors.ts` | Zod 4 定义实体、输入、查询结果、事件、错误码；三种接口直接复用 |
| 引擎 | `packages/engine/src/engine.ts` | 任务规则、版本检查、today/next 排序、系列实例生成、提醒同步、幂等存储；依赖注入 `Clock` |
| 存储 | `packages/engine/src/db.ts` | better-sqlite3、WAL、`schema_migrations`、迁移前 `VACUUM INTO` 备份到 `backups/` |
| 调度器 | `packages/engine/src/scheduler.ts` | 每 5s 检查到期提醒；发送前核对任务状态；失败退避重试 3 次；跨日补齐实例并发 `day.changed`；启动／唤醒后错过的提醒合并为摘要 |
| 通知桥 | `packages/engine/src/notifier.ts` | 调用 `TodoCueNotifier deliver/status/request`；缺失时降级 osascript |
| 服务 | `packages/server/src/app.ts`, `runtime.ts` | 令牌认证、`Idempotency-Key`、错误映射、SSE `/v1/events`（`Last-Event-ID` 回放）、单实例检查、`connection.json`（0600） |
| 客户端 | `packages/server/src/client.ts` | 类型化 HTTP 客户端，CLI 与 MCP 共用 |
| CLI | `packages/cli/src/` | commander；`serve`、`service *`、`install`、`doctor`、`export`、`mcp` |
| macOS | `apps/macos/Sources/{TodoCueKit,TodoCue,TodoCueNotifier}` | 见 `apps/macos/README.md` |

## 3. 关键规则的实现方式

- **时间**：具体时刻存 UTC ISO，任务保留 IANA 时区；`scheduledDate`/`scheduledAt`、`dueDate`/`dueAt` 互斥；本地 ISO 输入按时区解释（luxon）。
- **today**：入选原因 `overdue` / `due_today` / `scheduled_today` / `carried_over`，分区 overdue → must → scheduled；今日完成按 `completedAt` 的本地日期。
- **next**：排除计划时间未到的任务；分组 overdue → due_today → scheduled_reached → unscheduled；组内按优先级、截止、计划日期、创建顺序。
- **系列**：每日／每周（ISO 星期）；预生成 30 天，`generatedThrough` 记录进度；启动、跨日、`today/next/list` 查询时补齐；`(series_id, occurrence_date)` 唯一索引防重；生成时已过去的提醒时刻不再创建提醒。
- **夏令时**：按系列时区的本地时间生成；不存在的时刻顺延（luxon 行为），重复时刻取第一次（测试覆盖 America/New_York 2026-03-08 与 2026-11-01）。
- **系列操作**：编辑、改期、完成、跳过只影响当前实例；停止系列取消 `occurrence_date > today` 的待办实例，保留今天与历史；修改规则 = 停止 + 新建。
- **提醒**：每任务一条显式提醒；`reminders` 表与 `task.reminderAt` 同事务同步；完成／取消／跳过使待发送提醒失效；撤销完成不补发已过去的提醒；通知标识 = 任务 id，重复投递会替换而非叠加。
- **一致性**：`version` + `expectedVersion` → `VERSION_CONFLICT`（客户端刷新后提示）；`Idempotency-Key` 按 `方法+路径+键` 存储响应 24h，同键不同请求体 → `IDEMPOTENCY_MISMATCH`。
- **安全**：只监听 127.0.0.1；`token`、`connection.json` 为 0600；`~/.todocue` 为 0700。

## 4. 实施顺序（实际）

1. 契约与接口文档（`docs/api.md`）先行，macOS 客户端与 Runtime 并行开发。
2. 引擎 + 迁移 + 调度器，21 项单测（可控时钟、内存库）。
3. Fastify API、SSE、幂等、并发；8 项集成测试（真实端口、真实调度器）。
4. CLI、LaunchAgent、`install`/`doctor`/`export`、MCP；4 项单测 + stdio 探针。
5. macOS：TodoCueKit（13 项 XCTest）、面板、刘海快览、表单、详情、设置、通知辅助程序、打包脚本。
6. 联调：真实运行时 + 真实 App；修复 SSE（`AsyncBytes.lines` 吞掉空行导致事件不完整）。

## 5. 验收记录（2026-09-07，macOS 26.5 / Node 26.7 / Swift 6.3）

| 场景 | 结果 |
|---|---|
| 跨入口一致性 | CLI 新建／完成后，菜单栏剩余数量 1.2s 内由 3 变 5；面板显示与 `todocue today`、MCP `todocue_today` 一致 |
| 提醒实时性 | `--remind +1m` 的提醒在到点后 2s 内经辅助程序提交（`submitted via helper`） |
| 幂等／并发 | 同 `Idempotency-Key` 重放返回同一任务；旧 `expectedVersion` 返回 409 `VERSION_CONFLICT`（HTTP、CLI、MCP 均验证） |
| 业务规则 | 昨日未完成、单次改期、跳过、停止系列、跨日、夏令时、撤销完成：引擎单测覆盖并通过 |
| 后台可靠性 | `service install/status/restart/uninstall` 在隔离 `TODOCUE_HOME` 下验证；SIGTERM 优雅停止；卸载保留数据 |
| 诊断 | `doctor` 列出 home、数据库、LaunchAgent、辅助程序、运行时、通知授权、失败提醒、时区 |
| 视觉 | 浅色模式真实桌面截图：面板 380×680、圆角磨砂、下一项卡片、今日分区、快速添加 |

尚未在本机验证（需要用户交互或特定硬件）：刘海屏悬停展开（测试机当前活动屏无刘海，仅验证菜单栏路径）、通知点击定位（需用户点击系统通知）、通知授权弹窗（未主动触发，避免打断用户）、深色模式与减少动态效果的截图、多显示器插拔。

## 6. 运维与文件

- 数据：`~/.todocue/todocue.sqlite`（+ `-wal`）、`backups/`、`logs/runtime.log`、`logs/launchd.*.log`。
- 服务：`~/Library/LaunchAgents/com.todocue.runtime.plist`（KeepAlive，RunAtLoad，指向当前 node 与 `packages/cli/dist/index.js serve`）。
- 应用：`~/Applications/TodoCue.app`、`~/.todocue/bin/TodoCueNotifier.app`、`~/.todocue/bin/todocue`（wrapper，并尝试链接到 `/opt/homebrew/bin`）。
- 卸载：`todocue service uninstall`（保留数据）；彻底删除需手动移除 `~/.todocue` 与两个 app。

## 7. 已知限制 / 后续

- 修改重复规则需停止旧系列再新建；系列不支持每月／自定义间隔。
- 全屏应用检测采用窗口尺寸启发式。
- 辅助程序缺失时的 osascript 通知不支持点击定位。
- Node 24 为基线但仅在 Node 26.7 上实际验证；better-sqlite3 需要与运行 node 版本匹配的预编译二进制。


## 8. UI 与交互优化（2026-09-07）

本轮沿现有 SwiftUI + AppKit 实现优化，未替换 Runtime 或修改任务业务引擎。
实际修改及 Computer use 证据见 [ui-review.md](ui-review.md)。

用户在实测中明确更新了交互要求：**失焦不等于收起**。侧栏默认在其他 App 工作时保持可见；
显示面板不激活 TodoCue，只在明确进入编辑时请求输入焦点。× 主动收起，Esc 先返回上层并保留草稿，
在根列表收起（固定时防止 Esc 误收起）。此前“未固定时点击外部收起”的基线不再适用。
