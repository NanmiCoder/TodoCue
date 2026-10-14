# TodoCue desktop preview

共享 React / TypeScript / Motion 界面与 Tauri 2 宿主，复用现有任务引擎、数据库、REST API、CLI 和 MCP。当前是迁移预览，正式 macOS 发行版仍使用 `apps/macos`；Apple 日历/提醒事项同步仍由旧客户端负责。

## 本地预览

需要 Node 24+；原生预览还需要 Rust 1.90+ 和所在平台的 Tauri 开发工具链。

```sh
npm ci
npm run desktop:dev
```

打开 `http://127.0.0.1:5173/` 查看面板；`?surface=notch` 查看刘海。脚本使用系统临时目录下的 `todocue-desktop-development`，运行真实 CLI / API / SQLite，默认不读取个人数据。终端输出对应 CLI 命令；Ctrl+C 停止这组开发进程。不要把终止开发脚本当作“退出已安装 UI”的后台服务测试。

原生开发可以先在一个终端运行隔离运行时，再在另一终端运行 `npm run desktop:native`。该命令会自行启动 Vite；如果已经运行上述 `desktop:dev`，使用：

```sh
npm run tauri --workspace @todocue/desktop -- dev --config '{"build":{"beforeDevCommand":""}}'
```

也可以构建 macOS 对照 App，配合上述临时运行时运行：

```sh
npm run desktop:build
npm run tauri --workspace @todocue/desktop -- build --debug --bundles app --config '{"bundle":{"active":true}}'
```

产物在 `src-tauri/target/debug/bundle/macos/TodoCue Preview.app`。macOS 预览默认仍使用临时目录；没有接入 EventKit、旧版偏好迁移和真实硬件刘海，不替代当前 SwiftUI App。

## Windows 构建

在对应架构的 Windows 主机上运行。安装 MSVC C++ 构建工具、Windows SDK 和 Rust；ARM64 需要对应的 C++ ARM64 工具链。

```powershell
npm ci --ignore-scripts
npm run windows:preview
```

脚本构建前端与三个原生辅助程序，下载并校验官方 Node 26.7.0，安装锁定的生产依赖，实际用该架构的 Node 和 SQLite执行 SQL，再生成当前用户级 NSIS 安装包和 SHA-256 文件。携带 WebView2 离线安装程序和 TodoCue Skill。Rust Windows 目标静态链接 CRT，SQLite 分发保留对应架构的原生模块。

`.github/workflows/desktop-preview.yml` 提供 Windows x64、Windows ARM64 和 macOS 检查；可手动触发，或由相关 PR 触发。本工作区没有触发远程构建，也没有在 Windows 上安装/运行产物。

安装后第一次启动建立当前用户的后台计划任务并安装 CLI：`%USERPROFILE%\.todocue\bin\todocue.exe`。数据默认在 `%USERPROFILE%\.todocue`，支持 `TODOCUE_HOME`。当前终端尚未刷新 PATH 时可以直接使用此绝对路径。关闭面板或从托盘退出 UI，不停止已安装的后台服务；`service stop` / 卸载才停止服务。

自定义数据目录会登记在 `%LOCALAPPDATA%\TodoCue\homes`，安装器升级/卸载不依赖原终端的环境变量。通知链接带目录标识，冷启动和热启动都选择原目录；普通启动恢复该安装最近登记的目录，也可以用 `--home <绝对路径>` 显式打开。产品卸载清理属于该安装的服务、CLI、指针及受管理 PATH，保留任务数据；`service uninstall` 只移除后台服务。更新/维护替换保留目录关联并恢复原本运行的服务。

## 验证与迁移状态

```sh
npm run check
npm run desktop:check
swift test --package-path apps/macos
```

[交接任务与继续开发说明](../../docs/desktop-handoff.md)列出当前最优先的刘海焦点问题、未完成任务、工作树启动方式和验收条件。[实施与验收记录](../../docs/desktop-migration.md)包含已验证的真实入口、原生对照参数、Windows 实机清单与尚未完成的 macOS 迁移。Tauri 的[窗口与安装说明](https://v2.tauri.app/distribute/windows-installer/)作为平台配置参考，不能替代实机验收。
