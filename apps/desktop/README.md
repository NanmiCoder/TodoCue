# TodoCue desktop preview

共享 React / TypeScript / Motion 界面与 Tauri 2 宿主，复用现有任务引擎、数据库、REST API、CLI 和 MCP。当前是迁移预览，正式 macOS 发行版仍使用 `apps/macos`；Apple 日历/提醒事项同步仍由旧客户端负责。

## 本地预览

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
TODOCUE_HOME=/tmp/todocue-desktop-dev "apps/desktop/src-tauri/target/debug/bundle/macos/TodoCue Preview.app/Contents/MacOS/todocue-desktop"
```

产物在 `src-tauri/target/debug/bundle/macos/TodoCue Preview.app`。macOS 预览默认仍使用临时目录；没有接入 EventKit、旧版偏好迁移和真实硬件刘海，不替代当前 SwiftUI App。

## Windows 构建

在对应架构的 Windows 主机上运行。安装 MSVC C++ 构建工具、Windows SDK 和 Rust；ARM64 需要对应的 C++ ARM64 工具链。

```powershell
npm ci --ignore-scripts
npm run windows:preview
```

脚本对 Tauri 打包下载阶段的 `Peer disconnected` 限次重试（三次总尝试）；编译、校验和或 NSIS 错误不会被重试或忽略。脚本构建前端与三个原生辅助程序，下载并校验官方 Node 26.7.0，安装锁定的生产依赖，实际用该架构的 Node 和 SQLite执行 SQL，再生成当前用户级 NSIS 安装包和 SHA-256 文件。携带 WebView2 离线安装程序和 TodoCue Skill。Rust Windows 目标静态链接 CRT，SQLite 分发保留对应架构的原生模块。

`.github/workflows/desktop-preview.yml` 提供 Windows x64、Windows ARM64 和 macOS 检查；可手动或由相关 PR 触发。代码 `7ad1b95` 的 [本轮 CI](https://github.com/NanmiCoder/TodoCue/actions/runs/38571147367) 三个 job 全通过，Windows 两种架构实际执行了包内 Node/SQLite、当前用户后台计划任务、CLI/MCP、重装恢复及卸载保留数据库的七组冒烟。

预览下载：[x64](https://github.com/NanmiCoder/TodoCue/actions/runs/38571147367/artifacts/11898134377)、[ARM64](https://github.com/NanmiCoder/TodoCue/actions/runs/38571147367/artifacts/11899180283)，包括 NSIS 和 SHA-256；需要仓库访问权限，按 CI artifact 保留策略过期，不是正式 Release。x64 runner 为 Windows Server 2025，ARM64 为 Windows 11，尚不代表 Windows 10/11 GUI 验收。

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

本地 `check` 175 个 Vitest / 24 个脚本测试、CLI/MCP 冒烟及 release check 通过；`desktop:check` 前端/Rust 11+5 通过。[Quality CI](https://github.com/NanmiCoder/TodoCue/actions/runs/38571147359) 的完整 Xcode Swift Apple Silicon 275（4 跳过）、Intel 275（11 跳过）均 0 失败。本地 CLT 缺 XCTest，不冒充本地通过。

真实鼠标外部点击、候选窗口、透明命中、Windows GUI/通知点击/多屏/DPI/休眠、全原生视觉/逐帧验收，以及 Mac Intel Tauri 包、EventKit 和正式客户端切换仍待完成。
