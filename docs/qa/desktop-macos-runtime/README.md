# Mac Preview 直接打开后持续离线

2026-10-16，修复分支 `codex/macos-preview-runtime-connection`。用户报告界面持续显示“后台服务未连接”，无法输入和创建。

## 原因与修复

后台健康检查正常，连接文件和原任务都在隔离测试目录。失败的 App 进程没有 `--home` 参数或 `TODOCUE_HOME` 环境变量，旧代码因此读取临时开发目录；该目录没有 connection.json。之前的安装只配置了桌面脚本这一条入口，直接打开 App 会丢失选择。单独重启后台不能修复这个路径问题。

Mac release 配置的 Preview 在主实例 setup 阶段记住显式选定的目录，保存在用户 Application Support 下的 `TodoCue Preview/launch-home.json`。后续直接启动优先级为显式参数、环境变量、已记住目录、临时预览默认。debug 不读取或写入该记录。记录只有版本与目录，权限为0600，不保存连接 token；无效、损坏或不支持的记录不会引导到个人生产目录。

原子写入失败不阻止显式启动；相对目录仍按原显式启动行为处理，但不持久化。保存发生在主实例 setup，而不是单实例转发的第二个进程中。Windows 的注册目录、单实例路由与后台行为保持原路径。

## 本机已验证

- 复现：原进程没有 home 参数或环境变量，后台 /v1/health 正常，临时目录没有连接文件，UI 显示离线且输入禁用。
- Apple Silicon release Preview 重新构建、ad-hoc 整包签名和架构验证通过。替换本机 App 前保留了原 App 回滚副本，没有替换任务数据库或后台运行时。
- 桌面脚本第一次启动后，记住的目录与现有隔离后台一致，原验证任务恢复。
- 正常退出，再直接打开 App：新进程确认没有 home 参数或环境变量，仍自动连接相同后台，原任务保留，输入框启用。
- 在这次无参数启动的 App 中输入 `Direct app launch connection check`、按一次 Return，创建后输入清空；只读 SQLite 核对该标题恰好一条，原来的安装验证任务仍在。UI 显示2条，后台保持健康。
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`：Mac 18+5 通过，其中新增7项覆盖带中文/空格目录与重开、显式覆盖与切换、缺失/损坏、无效/不支持格式、保留旧选择、无凭据/0600及写入失败。
- `npm run check`：208项 Vitest / 29文件、34项脚本测试、CLI/MCP/数据库重启/导出及版本检查通过。前端构建与 `cargo fmt` 通过。

本轮没有读取个人生产数据库、重写引擎/API/数据库或发布正式版本。新代码的远程 CI 与 Intel 构建以对应 PR 的结果为准，不能把本机 Apple Silicon 验证写成 Intel 或 Windows 实机通过。

## 保留的边界

这解决“后台正常但 App 找错目录”的直接启动故障。外部运行时仍需安装并正常运行；没有在本轮补齐共享 Mac 的正式运行时打包、EventKit、偏好迁移或完整原生视觉/设备验收。
