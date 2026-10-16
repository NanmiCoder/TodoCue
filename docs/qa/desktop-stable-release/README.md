# v0.6.0 共享桌面正式分发验证

2026-10-16。用户明确授权 merge、CI、Mac / Windows 正式 Release；本轮继续使用隔离 worktree，不改个人生产数据库。

## 本机通过

- `npm run check`：209 项 Vitest、36 项发布/打包脚本测试，真实 CLI/MCP/附件/提醒/SSE/持久化重启与 v0.6.0 版本检查通过。
- `desktop:check` / Rust：共享前端生产构建、Rust 19+5 通过；新旧协议路径校验保留。新增隔离回归确保未带运行时的 CI App 不读取正式目录指针，仍默认临时 home；只有独立正式包使用生产默认目录。
- `npm run desktop:macos`：原生 arm64 独立 DMG 构建通过，内置 Node 26.7.0、对应 SQLite、MCP 加载成功，App 深度严格签名验证通过。本机为 ad-hoc 测试包，不称为已公证正式包。
- 将独立 App 副本放在持久化测试安装目录，通过 Finder 打开携带显式隔离 home 的预检启动器；包内 CLI 自动升级原隔离 LaunchAgent 为 v0.6.0，端口 58863 保留，原任务恢复。
- 原生 AX 输入 `Stable standalone package check`，Return 创建后 UI/SSE 刷新；只读 SQLite 查询确认同名任务恰好一条。
- 正常退出 UI，包内后台仍运行；无 TODOCUE_HOME 的已安装 CLI context 返回 0.6.0。无参数直接重开 App 后仍显示原任务，输入可用；正式目录指针匹配隔离 home。
- 旧 Preview 经正常菜单退出；未通过杀进程丢弃输入。测试启动和修改的都是此前安装的隔离目录，未读取或更改 `~/.todocue`。

## 云端结果

初次正式预检 ARM 的 App/DMG 签名、公证、staple 和 Gatekeeper 已通过；安装回归执行到卸载后，因脚本误把 CLI 的 removed 字段当成 running 而失败。已按契约修正；当前提交和最终 tag 的完整结果在完成后补充。只有四个安装包和各自校验和都齐全且匹配，发布器才允许公开；发布脚本对缺少 Windows 包、Mac 包篡改、公开版本覆盖、API/上传失败均有回归。

## 保留边界

Mac 本机测试是 arm64，Intel 完整打包依赖 CI。Windows 没有接入物理设备，继续两种架构的真实 NSIS 安装回归，GUI / DPI / 多屏 / 休眠 / 通知点击不能标为通过。Mac 真实鼠标、IME 候选、逐帧动效也不由 AX 或 CI 代替。

共享版 Apple 日历/提醒事项同步、硬件刘海安全区和全部偏好导入尚未实现。正式发布说明明确列出这些差异，并保留 v0.5.3 SwiftUI 回退。任务引擎、API 与数据库格式兼容。
