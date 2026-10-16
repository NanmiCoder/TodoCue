# TodoCue shared desktop

v0.6.0 起正式桌面客户端使用 React / TypeScript / Motion 与 Tauri 2，复用现有引擎、数据库、API、CLI 和 MCP。Mac / Windows 正式安装包都内置对应架构运行时，首次打开自动配置后台，无需另装 Node；关闭 UI 后服务继续运行。

Mac 打包：`npm run desktop:macos`；正式签名/公证：`npm run desktop:macos -- --release`。产物为 `apps/desktop/build/TodoCue-<version>-macOS-<arm64|x64>.dmg`。Windows 对应架构打包：`npm run windows:build -- --release`，产物为 `TodoCue-<version>-Windows-<arm64|x64>-setup.exe`。`Release desktop (Mac and Windows)` 在 tag 上构建四种安装包，验证所有校验和后才发布；手动运行只构建验收，不公开 Release。Windows 暂无 Authenticode 证书，安装包未签名。

正式版默认 `~/.todocue`，显式 `--home` / `TODOCUE_HOME` 优先；Mac 选择记在 `~/Library/Application Support/TodoCue/launch-home.json`，后续 Finder/Dock 打开复用。debug、开发脚本和没有内置运行时的 CI App 默认仍用临时隔离目录；裸 App 不读取或改写正式目录指针。正式版不自动读取旧 Preview 的目录指针。Mac 包含签名通知辅助程序、runtime BUILD.json 和 Skill；与旧 SwiftUI 包使用兼容的 CLI bootstrap，保留数据格式和后台端口。检测到旧 SwiftUI App 正在运行会提示退出。

**当前边界：** 旧 SwiftUI 的 Apple 同步、硬件刘海和全部偏好导入尚未接入；保留旧源码和 v0.5.3 回退。Windows 硬件 GUI、原生鼠标/IME 与逐帧动效仍待验收，见[发布说明](../../release-notes/v0.6.0.md)。以下是迁移期间的开发说明与历史验证记录；其中 Preview 下载和外部后台条件仅适用于旧预览产物。

v0.6.0 的[公开 Release](https://github.com/NanmiCoder/TodoCue/releases/tag/v0.6.0)包含 Mac ARM64/Intel 与 Windows x64/ARM64；[正式流水线](https://github.com/NanmiCoder/TodoCue/actions/runs/38916287661)全部通过，安装与尚未验收边界见[正式分发记录](../../docs/qa/desktop-stable-release/README.md)。

## 本地预览

本节保留迁移期间的 Preview 验证方式；旧预览下载、外部后台及 SwiftUI 分发说明以对应日期为准。当前正式包和最新验证以本文开头及[正式分发记录](../../docs/qa/desktop-stable-release/README.md)为准。

需要 Node 24+；原生预览还需要 Rust 1.90+ 和所在平台的 Tauri 开发工具链。

```sh
npm ci
TODOCUE_HOME=/tmp/todocue-desktop-dev npm run desktop:dev
```

打开 `http://127.0.0.1:5173/` 查看面板；`?surface=notch` 查看刘海。上例使用指定的 `/tmp/todocue-desktop-dev`；不设置 `TODOCUE_HOME` 时默认使用系统临时目录下的 `todocue-desktop-development`。脚本运行真实 CLI / API / SQLite，默认不读取个人数据。终端输出对应 CLI 命令；Ctrl+C 停止这组开发进程。不要把终止开发脚本当作“退出已安装 UI”的后台服务测试。

原生开发可以先在一个终端运行隔离运行时，再在另一终端使用同一 `TODOCUE_HOME` 运行 `npm run desktop:native`。该命令会自行启动 Vite；如果已经运行上述 `desktop:dev`，使用：

```sh
TODOCUE_HOME=/tmp/todocue-desktop-dev npm run tauri --workspace @todocue/desktop -- dev --config '{"build":{"beforeDevCommand":""}}'
```

也可以构建 macOS 对照 App，配合上述临时运行时运行：

```sh
npm run desktop:build
npm run tauri --workspace @todocue/desktop -- build --debug --bundles app --config '{"bundle":{"active":true}}'
TODOCUE_HOME=/tmp/todocue-desktop-dev "apps/desktop/src-tauri/target/debug/bundle/macos/TodoCue.app/Contents/MacOS/todocue-desktop"
```

产物在 `src-tauri/target/debug/bundle/macos/TodoCue.app`。macOS 预览默认仍使用临时目录；没有接入 EventKit、旧版偏好迁移和真实硬件刘海，不替代当前 SwiftUI App。

macOS release 配置的 Preview 首次通过 `--home` 或 `TODOCUE_HOME` 选择隔离运行时后，会把目录记在 `~/Library/Application Support/TodoCue Preview/launch-home.json`。以后从应用程序、Dock 或 Finder 直接打开仍连接该目录，避免误回到没有后台的临时目录。显式参数/环境仍优先；debug 开发预览不读取或更新这个选择。记录仅含目录和版本，不含 token；外部后台仍需正常运行。见[直接打开后离线的修复与实测](../../docs/qa/desktop-macos-runtime/README.md)。

桌面 CI 的 macOS matrix 在 Apple Silicon 与 Intel runner 分别构建 release 配置的共享 Preview App，验证 Mach-O 架构和 ad-hoc 签名，上传 `todocue-macos-arm64-desktop-preview` / `todocue-macos-x64-desktop-preview`。Artifact 含 App ZIP、SHA-256 和 `BUILD.json`，记录版本、架构与源码提交。两架构已在 CI 实测通过，下载后架构/整包签名/校验和亦通过；见[下载与构建记录](../../docs/qa/desktop-builds/README.md)。这些共享 App 尚需外部隔离运行时；现有 `Release macOS` 手动 Action 另行构建带运行时、Developer ID 签名及公证的 SwiftUI DMG，两类产物应分别使用。

## 刘海与面板的宿主行为

- 刘海悬停以 WebView 的 DOM 悬停为主；宿主每 100ms 读取指针位置并发出 `notch:pointer` 事件作兜底（应用未激活时 WebView 可能收不到鼠标事件）。DOM 事件最近 300ms 内有到达时以 DOM 为准。设置环境变量 `TODOCUE_NOTCH_POINTER=0` 可关闭宿主兜底。需真机验证。
- 刘海展开后，只有点输入框或刘海带才向宿主请求键盘；点卡内按钮不再 `set_focus`（Windows 同时保持 `WS_EX_NOACTIVATE`）。
- 面板从隐藏变可见才重新定位；已打开时只置前。显示/隐藏带 0.16s/0.18s 淡入淡出：macOS 淡化整个窗口，Windows 由页面 CSS 淡化（透明 WebView2 窗口不是分层窗口）。系统“减弱动态效果”时直接显示/隐藏。
- macOS 主菜单只有“编辑”（剪切/拷贝/粘贴/全选）；托盘/菜单栏由刘海 WebView 通过 `tray_update` 推送状态后动态生成菜单；macOS 用模板图标和菜单栏数字，Windows 用橙色图标、悬停提示显示剩余数，左键切换面板，右键打开菜单。
- 刘海内任务右键菜单与面板一致；菜单打开时窗口按菜单高度增高（上限 560）并把快览固定，关闭后恢复。“编辑…”“删除…”通过 `reveal_task` 的 `mode`（`edit` / `delete`）让面板打开编辑表单或先弹出删除确认。
- 设置页“打开数据文件夹”调用 `open_data_dir`，宿主只打开自己运行所用的数据目录，不接受前端传入路径。附件“另存为”调用 `save_file`：宿主用 token 直接向运行时取附件并弹系统保存对话框（`tauri-plugin-dialog`），字节不经过 IPC；未保存草稿里的附件没有运行时 id，走浏览器下载。
- 导出 JSON 由宿主写入系统下载目录并在 Finder / 资源管理器中定位，文件名固定为 `todocue-export-YYYY-MM-DD.json`。

## Windows 构建

在对应架构的 Windows 主机上运行。安装 MSVC C++ 构建工具、Windows SDK 和 Rust；ARM64 需要对应的 C++ ARM64 工具链。

```powershell
npm ci --ignore-scripts
npm run windows:preview
```

脚本对 Tauri 打包下载阶段的 `Peer disconnected` 限次重试（三次总尝试）；编译、校验和或 NSIS 错误不会被重试或忽略。脚本构建前端与三个原生辅助程序，下载并校验官方 Node 26.7.0，安装锁定的生产依赖，实际用该架构的 Node 和 SQLite执行 SQL，再生成当前用户级 NSIS 安装包和 SHA-256 文件。携带 WebView2 离线安装程序和 TodoCue Skill。Rust Windows 目标静态链接 CRT，SQLite 分发保留对应架构的原生模块。

`.github/workflows/desktop-preview.yml` 提供 Windows x64/ARM64 安装包与 macOS Apple Silicon/Intel 共享 App；可手动或由相关 PR 触发。[最新 CI](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756) 四个 job 全通过，Windows 两种架构实际执行了包内 Node/SQLite、当前用户后台计划任务、CLI/MCP、重装、恢复故障及卸载保留数据库的十组检查。

预览下载：[x64](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11924179248)、[ARM64](https://github.com/NanmiCoder/TodoCue/actions/runs/38624606756/artifacts/11924138417)，包括 NSIS 和 SHA-256；需要仓库访问权限，按 CI artifact 保留策略过期，不是正式 Release。x64 runner 为 Windows Server 2025，ARM64 为 Windows 11，尚不代表 Windows 10/11 GUI 验收。

安装包冒烟仅在可弃用的 Windows 测试用户/runner 执行：

```powershell
npm run windows:preview
node scripts/smoke-windows-install.mjs
```

脚本自建临时中文/空格数据目录，使用安装包内运行时；会安装/卸载 Preview、登记当前用户计划任务和 CLI/PATH。不要在个人生产安装上运行此脚本。

安装后第一次启动建立当前用户的后台计划任务并安装 CLI：`%USERPROFILE%\.todocue\bin\todocue.exe`。数据默认在 `%USERPROFILE%\.todocue`，支持 `TODOCUE_HOME`。当前终端尚未刷新 PATH 时可以直接使用此绝对路径。关闭面板或从托盘退出 UI，不停止已安装的后台服务；`service stop` / 卸载才停止服务。

自定义数据目录会登记在 `%LOCALAPPDATA%\TodoCue\homes`，安装器升级/卸载不依赖原终端的环境变量。通知链接带目录标识，冷启动和热启动都选择原目录；普通启动恢复该安装最近登记的目录，也可以用 `--home <绝对路径>` 显式打开。产品卸载清理属于该安装的服务、CLI、指针及受管理 PATH，保留任务数据；`service uninstall` 只移除后台服务。更新/维护替换保留目录关联并恢复原本运行的服务。

## 验证与迁移状态

```sh
npm run check
npm run desktop:check
swift test --package-path apps/macos
```

[交接任务与继续开发说明](../../docs/desktop-handoff.md)列出当前最优先的刘海焦点问题、未完成任务、工作树启动方式和验收条件。[实施与验收记录](../../docs/desktop-migration.md)包含已验证的真实入口、原生对照参数、Windows 实机清单与尚未完成的 macOS 迁移。Tauri 的[窗口与安装说明](https://v2.tauri.app/distribute/windows-installer/)作为平台配置参考，不能替代实机验收。

本轮修正原生窗口/WebView 焦点、粘贴/回车和箭头提交期间继续输入，校准表单/附件、详情、日历及 Dial。见 [P0 输入证据](../../docs/qa/desktop-native-ui-fixes/README.md) 和 [P1 对照截图、632 条布局测量与安装验证](../../docs/qa/desktop-p1-ui/README.md)。实际系统偏好切换、版本冲突和延迟响应保留草稿均通过。

前一轮 UI 对照阶段的本地 `check` 175 个 Vitest / 24 个脚本测试、CLI/MCP 冒烟及 release check 通过；`desktop:check` 前端/Rust 11+5 通过。[当时的 Quality CI](https://github.com/NanmiCoder/TodoCue/actions/runs/38571147359) 的完整 Xcode Swift Apple Silicon 275（4 跳过）、Intel 275（11 跳过）均 0 失败。本地 CLT 缺 XCTest，不冒充本地通过。

真实鼠标外部点击、候选窗口、透明命中、Windows GUI/通知点击/多屏/DPI/休眠、全原生视觉/逐帧验收，以及 EventKit、全部偏好迁移仍待完成。共享 Mac 正式运行时、签名/公证和客户端分发切换的最新结果见正式分发记录。Mac Intel Tauri release 预览包的构建与归档验证已通过。

2026-10-15的[独立审查修复](../../docs/qa/desktop-review-fixes/README.md)补齐CLI所属目录、bootstrap端口、普通Return、日历选择、Pin、图片、逾期、提醒与被动窗口焦点；本地208项Vitest/34项脚本测试及desktop检查通过。最新50762d4两架构十组安装及恢复失败/不健康测试均通过，正式分发和完整SwiftUI复刻仍未验收。
