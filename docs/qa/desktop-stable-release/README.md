# v0.6.0 共享桌面正式分发验证

2026-10-16。用户明确授权 merge、CI、Mac / Windows 正式 Release；本轮继续使用隔离 worktree，不改个人生产数据库。

## 公开 Release 与最终 CI

[v0.6.0](https://github.com/NanmiCoder/TodoCue/releases/tag/v0.6.0) 已于 `2026-10-16T15:16:26Z` 公开，为 Latest、非 draft、非 prerelease。[正式流水线](https://github.com/NanmiCoder/TodoCue/actions/runs/38916287661) 第 2 次执行成功，四平台及发布任务全通过。两个 Mac runner 完成共享 App/DMG 的 Developer ID 签名、公证、staple、独立 validate、Gatekeeper 与真实独立包 CLI/bootstrap/附件/重启/端口/卸载保留数据回归；Windows x64/ARM64 各完成十组 NSIS 安装/恢复/CLI/MCP/卸载检查。

公开 SHA256SUMS 的四条记录分别与 GitHub Release 资产内容 digest 一致；本机安装 DMG 也匹配公开 Mac ARM 校验和。所有资产、大小、源码和 job 链接见 [机器可读验证记录](release.json)。

| 资产 | SHA-256 |
| --- | --- |
| `SHA256SUMS` | `1a3093c308fafa5f572156c1869fdc1b1f9f6bfa782ccbca4b7a0e11498cf9ff` |
| `TodoCue-0.6.0-macOS-arm64.dmg` | `c2c8abb765ad424aaf4f8520fa301217d123f4821bf29ddce563c2c2f0d831df` |
| `TodoCue-0.6.0-macOS-x64.dmg` | `4b8ffd32d0458f7c3218a36bacfaaf06b6598ba931959637b7e871c74eab8402` |
| `TodoCue-0.6.0-Windows-arm64-setup.exe` | `6879e5bda0a0bdd04effd706fa5fc7bfde1becf5e2a2dc7e21e789192b40a5c7` |
| `TodoCue-0.6.0-Windows-x64-setup.exe` | `59bb511a33943737b65046155b2a1196dae8ed0948ea8fb47948bcde057f88e0` |

## 最终源码与本机安装

[PR #21](https://github.com/NanmiCoder/TodoCue/pull/21) 已合并 main，最终 v0.6.0 源码为 `62a4d16c97d0c4bf40ea62062781ba2c290eb539`；[合并后 Quality](https://github.com/NanmiCoder/TodoCue/actions/runs/38915500812) 三项全通过。[正式发布流水线](https://github.com/NanmiCoder/TodoCue/actions/runs/38916287661) 已实测成功，记录不使用旧候选结果替代。

该流水线首次执行中，Mac ARM 与 Windows x64/ARM64 通过；Intel 在 Apple 已接受 App 公证后，`stapler staple` 访问 CloudKit 时遇到同类 -1005 / Error 68 断连。尚未运行到后续独立 validate，不能将其记为票据验证成功。凭据已清理且 Rust 缓存成功保存；仅重跑失败 job，保留三个通过平台的原产物；第 2 次执行中 Intel 全部检查通过，随后发布任务完成公开。

本机从该流水线下载 Mac ARM 产物，复核 artifact digest、ZIP CRC、DMG SHA-256、四个二进制的 arm64 架构、App 深度严格签名、App/DMG 的 Apple 公证票据与 Gatekeeper。DMG SHA-256 为 `c2c8abb765ad424aaf4f8520fa301217d123f4821bf29ddce563c2c2f0d831df`。已替换 `/Applications/TodoCue.app`；旧 SwiftUI 与旧候选安装保存在可回退目录。无参数直接打开最终 App 后，确认原隔离目录的 4 条待办和 1 条已完成恢复，输入启用；后台自动使用最终签名 runtime，BUILD.json 源码为 `62a4d16`，端口 58863 保留，LaunchAgent PID 与 connection.json 一致，普通已安装 CLI 返回 0.6.0。未操作个人生产 `~/.todocue`。

## 本机先前的行为回归

- `npm run check`：209 项 Vitest、41 项发布/打包脚本测试，真实 CLI/MCP/附件/提醒/SSE/持久化重启与 v0.6.0 版本检查通过。
- `desktop:check` / Rust：共享前端生产构建、Rust 19+5 通过；新旧协议路径校验保留。新增隔离回归确保未带运行时的 CI App 不读取正式目录指针，仍默认临时 home；只有独立正式包使用生产默认目录。
- `npm run desktop:macos`：原生 arm64 独立 DMG 构建通过，内置 Node 26.7.0、对应 SQLite、MCP 加载成功，App 深度严格签名验证通过。本机为 ad-hoc 测试包，不称为已公证正式包。
- 将独立 App 副本放在持久化测试安装目录，通过 Finder 打开携带显式隔离 home 的预检启动器；包内 CLI 自动升级原隔离 LaunchAgent 为 v0.6.0，端口 58863 保留，原任务恢复。
- 原生 AX 输入 `Stable standalone package check`，Return 创建后 UI/SSE 刷新；只读 SQLite 查询确认同名任务恰好一条。
- 正常退出 UI，包内后台仍运行；无 TODOCUE_HOME 的已安装 CLI context 返回 0.6.0。无参数直接重开 App 后仍显示原任务，输入可用；正式目录指针匹配隔离 home。
- 旧 Preview 经正常菜单退出；未通过杀进程丢弃输入。测试启动和修改的都是此前安装的隔离目录，未读取或更改 `~/.todocue`。

## 云端结果（历史候选）

初次预检 ARM 的 App/DMG 签名、公证、staple 和 Gatekeeper 已通过；安装回归执行到卸载后，因脚本误把 CLI 的 removed 字段当成 running 而失败。已按契约修正，最终结果以本文开头的状态为准。只有四个安装包和各自校验和都齐全且匹配，发布器才允许公开；发布脚本对缺少 Windows 包、Mac 包篡改、公开版本覆盖、API/上传失败均有回归。

## 保留边界

Mac 本机测试是 arm64，Intel 完整打包依赖 CI。Windows 没有接入物理设备，继续两种架构的真实 NSIS 安装回归，GUI / DPI / 多屏 / 休眠 / 通知点击不能标为通过。Mac 真实鼠标、IME 候选、逐帧动效也不由 AX 或 CI 代替。

共享版 Apple 日历/提醒事项同步、硬件刘海安全区和全部偏好导入尚未实现。正式发布说明明确列出这些差异，并保留 v0.5.3 SwiftUI 回退。任务引擎、API 与数据库格式兼容。

## 候选构建与已完成的合并

[PR #20](https://github.com/NanmiCoder/TodoCue/pull/20) 已合并 main，提交 `1050bb1e82321a0e13dd3559a88e820188b0263b`。合并前 `3ceb75a` 的[Quality 三项](https://github.com/NanmiCoder/TodoCue/actions/runs/38904564490)及[Desktop 四架构](https://github.com/NanmiCoder/TodoCue/actions/runs/38904564075)全通过；[合并后 Quality](https://github.com/NanmiCoder/TodoCue/actions/runs/38907679767)三项全通过。合并树与预检源码 `git diff` 无差异。

[正式预检](https://github.com/NanmiCoder/TodoCue/actions/runs/38904559933) 的 Mac ARM 与 Windows x64/ARM64 全部通过；初始[候选 tag 流水线](https://github.com/NanmiCoder/TodoCue/actions/runs/38908046442)的三包通过，但 Intel 也在同一 Apple CloudKit 票据网络错误处失败，未公开 Release；后续通过 PR #21 合并 CI 修复后重建未发布候选。

本机下载预检 Mac ARM DMG 后验证了 artifact digest、ZIP CRC、允许的文件名、DMG SHA-256；UI、Node、SQLite 和 notifier 均为 arm64。DMG 和包内 App 的公证票据、Gatekeeper 与整包签名复核通过；runtime BUILD.json 确认为 shared-tauri / 0.6.0 / 3ceb75a。复制出 DMG 后无参数启动，自动恢复原隔离目录并以签名内置运行时接管后台；原任务显示正常，输入 `Signed v0.6.0 package check` 后 Return 创建成功，SQLite 只读查询恰好一条。此项确认 Developer ID 硬化运行时下的真实 UI 与后台通信，不只依赖 ad-hoc 本地构建。

公证包还验证了箭头提交后直接继续输入：输入控件保留焦点和完整编辑文本。只读 SQLite 确认首条 `Signed arrow submit check` 恰好一条，随后输入的草稿及组合文本均未误创建。测试后仅清理了该未提交草稿。

## CI 后续维护

Intel 预检曾在 App 已公证、staple 成功后被 Apple CloudKit 票据核验网络断连阻断（NSURLErrorDomain -1005 / stapler Error 68），并非 Invalid 公证结果。最终 tag 流水线第 2 次执行已恢复通过，完整结果见本文开头。

为当前发布补充最多三次票据验证重试，只匹配 Error 68 和已观察到的 -1005 传输失败。每次都重新执行完整验证，无效票据、信号终止和重复断连仍然失败。新增五个行为回归及完整 `npm run check` 通过（209 Vitest / 41 脚本）。初始候选 tag 的 Intel 正式任务也复现相同网络错误，当时尚未公开 Release；此修复通过 PR #21 合入 main（`62a4d16`），重建未发布候选，保留旧标签对象与旧 App 回退，见 [候选标签审计](candidate-tag-audit.json)。发布流水线同时保存在 Rust 检查后生成的缓存，避免票据网络失败导致下一次完整重编译。


Ego Lite 的本地链接点击实验返回 ERR_UNKNOWN_URL_SCHEME，未转交系统 App；因此该实验不作为原生通知链接的通过证据。保留真实通知冷/热启动验收。浏览器仅操作自建页面，TaskSpace 已关闭。
