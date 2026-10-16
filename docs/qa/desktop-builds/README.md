# 2026-10-15 合并与多架构构建

[PR #17](https://github.com/NanmiCoder/TodoCue/pull/17) 已按用户授权合并到 `codex/desktop-migration-handoff`，提交 `a57d012101737cb2f2772c3a11bdd7dd24c1280f`。随后手动运行合并提交的 Windows 构建与原 SwiftUI macOS 签名构建；没有合并 main、升级版本、推送版本标签或发布正式 Release。

[PR #18](https://github.com/NanmiCoder/TodoCue/pull/18) 补齐共享 macOS 的 Apple Silicon / Intel release App、架构和签名验证、ZIP / SHA-256 / BUILD.json，七项 CI 全通过后合并到同一交接分支，提交 `3bb8ceb382af14b84423f9d07caf0c82af09a1d2`。应用源码与 PR #17 合并提交相同，新增内容为构建配置、产物忽略规则和说明。

## 下载

以下产物版本均为 0.5.3，需要仓库访问权限。Mac artifacts 保留至 2026-10-28 UTC；Windows artifacts 保留至 2027-01-12 UTC。过期后可从交接分支重新手动运行 Action。

| 客户端 | 架构 | 产物 | 运行条件 |
| --- | --- | --- | --- |
| React / Tauri 共享 Preview | Windows x64 | [NSIS + SHA-256](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11924179248) | 自带 Node / SQLite / WebView2，当前用户后台服务 |
| React / Tauri 共享 Preview | Windows ARM64 | [NSIS + SHA-256](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11924138417) | 同架构运行时和辅助程序；安装验证通过 |
| React / Tauri 共享 Preview | macOS Apple Silicon | [App ZIP + SHA-256 + BUILD.json](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11923262615) | ad-hoc 签名，需要外部隔离运行时 |
| React / Tauri 共享 Preview | macOS Intel | [App ZIP + SHA-256 + BUILD.json](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11924328690) | ad-hoc 签名，需要外部隔离运行时 |
| 原 SwiftUI / AppKit 客户端 | macOS Apple Silicon | [Developer ID 公证 DMG + SHA-256](https://github.com/NanmiCoder/TodoCue/actions/runs/38622022217/artifacts/11921719565) | 自带运行时，保留旧客户端能力 |
| 原 SwiftUI / AppKit 客户端 | macOS Intel | [Developer ID 公证 DMG + SHA-256](https://github.com/NanmiCoder/TodoCue/actions/runs/38622022217/artifacts/11922939591) | 自带运行时，保留旧客户端能力 |

共享 Mac App 的启动与隔离运行时配置见[桌面 README](../../../apps/desktop/README.md)。原 SwiftUI DMG 仍是原生客户端，不能用它证明共享客户端已完成正式 macOS 迁移。Windows 系统数据目录默认属于安装用户；验收时显式设置独立 `TODOCUE_HOME`。

## 实测通过

- [合并提交 Desktop Action](https://github.com/NanmiCoder/TodoCue/actions/runs/38622020315)：Windows 两架构构建和各十组安装冒烟、macOS 检查均通过。
- [新增四目标 Desktop Action](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756)：Windows x64 / ARM64 完整构建、Rust 13+6+4 和各十组真实 NSIS 安装/恢复故障检查通过；Mac 两架构前端构建、Rust 11+5、release App、Mach-O 和整包签名验证通过。
- [Quality Action](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606726)：Linux 208 项 Vitest / 29 文件、34 项脚本测试、CLI/MCP/重启/导出/release 检查通过；Swift Apple Silicon 275（4 跳过）、Intel 275（11 跳过），均 0 失败。Windows 的平台计数为 Vitest 207 通过 / 1 跳过，脚本 29 通过 / 5 跳过。
- [SwiftUI 签名 Action](https://github.com/NanmiCoder/TodoCue/actions/runs/38622022217)：两架构 Swift 测试、Developer ID 签名、App 与 DMG 公证、staple / validate / Gatekeeper 检查通过。Intel 第一次因 Apple 票据请求 `NSURLErrorDomain -1005` 网络中断失败；仅重跑失败任务，第二次全部通过，没有放宽校验。`Publish complete release` 为预期跳过。
- 本机 Apple Silicon 共享 release App 构建、ad-hoc 签名和原样 CI 归档脚本通过。下载两种架构 CI ZIP 后，核对 artifact 外层摘要、内层 SHA-256、CRC 和 BUILD.json，再用 ditto 解压并验证两种 App 的架构和完整签名，全部通过。原 SwiftUI Apple Silicon DMG 下载后的 SHA-256 和签名验证通过；Intel DMG 的签名和公证以 CI 实测为准。
- 已下载并核对 [Windows x64 冒烟报告](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11923959348) 与 [ARM64 冒烟报告](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11923743325)，各十项通过，包括计划任务故障、不健康恢复、数据/恢复标记保留和健康重试。

共享构建的 PR head 为 `1e33ef73a29407eed7e3418a2872e82936a3c4b9`；BUILD.json 记录的实际 PR 合并检查提交为 `6ae5d28238ab78d8cb9bb50d5c0ccf761b45153c`。它与最终合并提交 `3bb8ceb` 的 Git tree 均为 `eccb1cae0f5ca985214cf81b86fd66f1605a339c`，已核对一致。运行、artifact 摘要和安装报告见 [ci.json](ci.json)。

## 尚未验证或未完成

保留[独立审查修复记录](../desktop-review-fixes/README.md#仍未验证或未完成)与[交接清单](../../desktop-handoff.md)中的实机验收：Windows GUI / 通知 / DPI / 多屏 / 休眠，Mac 物理外部鼠标 / IME 候选 / 真实硬件刘海，以及完整原生主题与逐帧动效对照。不能宣称完全复刻 SwiftUI。

共享 Mac 的正式运行时打包/bootstrap、Developer ID 签名/公证、EventKit、偏好迁移与生产客户端切换仍未完成。当前构建成功不改变这些边界。未启动或读取个人生产数据，未发布正式版本。
