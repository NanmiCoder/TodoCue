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

## 已完成的合并与当前源码

[PR #20](https://github.com/NanmiCoder/TodoCue/pull/20) 已合并 main，提交 `1050bb1e82321a0e13dd3559a88e820188b0263b`。合并前 `3ceb75a` 的[Quality 三项](https://github.com/NanmiCoder/TodoCue/actions/runs/38904564490)及[Desktop 四架构](https://github.com/NanmiCoder/TodoCue/actions/runs/38904564075)全通过；[合并后 Quality](https://github.com/NanmiCoder/TodoCue/actions/runs/38907679767)三项全通过。合并树与预检源码 `git diff` 无差异。

[正式预检](https://github.com/NanmiCoder/TodoCue/actions/runs/38904559933) 的 Mac ARM 与 Windows x64/ARM64 全部通过；初始[候选 tag 流水线](https://github.com/NanmiCoder/TodoCue/actions/runs/38908046442)的三包通过，但 Intel 也在同一 Apple CloudKit 票据网络错误处失败，未公开 Release；将合并 CI 修复后重建本次未发布候选。

本机下载预检 Mac ARM DMG 后验证了 artifact digest、ZIP CRC、允许的文件名、DMG SHA-256；UI、Node、SQLite 和 notifier 均为 arm64。DMG 和包内 App 的公证票据、Gatekeeper 与整包签名复核通过；runtime BUILD.json 确认为 shared-tauri / 0.6.0 / 3ceb75a。复制出 DMG 后无参数启动，自动恢复原隔离目录并以签名内置运行时接管后台；原任务显示正常，输入 `Signed v0.6.0 package check` 后 Return 创建成功，SQLite 只读查询恰好一条。此项确认 Developer ID 硬化运行时下的真实 UI 与后台通信，不只依赖 ad-hoc 本地构建。

公证包还验证了箭头提交后直接继续输入：输入控件保留焦点和完整编辑文本。只读 SQLite 确认首条 `Signed arrow submit check` 恰好一条，随后输入的草稿及组合文本均未误创建。测试后仅清理了该未提交草稿。

## CI 后续维护

Intel 预检曾在 App 已公证、staple 成功后被 Apple CloudKit 票据核验网络断连阻断（NSURLErrorDomain -1005 / stapler Error 68），并非 Invalid 公证结果。仅失败 job 已重跑；最终发布是否成功以正式 tag 流水线为准。

为当前发布补充最多三次票据验证重试，只匹配 Error 68 和已观察到的 -1005 传输失败。每次都重新执行完整验证，无效票据、信号终止和重复断连仍然失败。新增五个行为回归及完整 `npm run check` 通过（209 Vitest / 41 脚本）。初始候选 tag 的 Intel 正式任务也复现相同网络错误，尚未公开 Release；此修复将并入 main 后重建未发布候选，保留旧标签对象与旧 App 回退。发布流水线同时保存在 Rust 检查后生成的缓存，避免票据网络失败导致下一次完整重编译。


Ego Lite 的本地链接点击实验返回 ERR_UNKNOWN_URL_SCHEME，未转交系统 App；因此该实验不作为原生通知链接的通过证据。保留真实通知冷/热启动验收。浏览器仅操作自建页面，TaskSpace 已关闭。
