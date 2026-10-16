# GitHub Actions 发布共享桌面（macOS / Windows）

v0.6.0 起，`.github/workflows/release-macos.yml` 的 `Release desktop (Mac and Windows)` 发布 React/Tauri 共享客户端。旧 SwiftUI 页面保留参考与回退，Mac 通知辅助程序继续复用 Swift。

## 正式版本

1. 在 `codex/` 分支完成实现、回归、`release-notes/vX.Y.Z.md` 和文档；使用 `npm run release -- X.Y.Z --dry` / `npm run release -- X.Y.Z` 同步全部版本。脚本创建 release commit 与本地 annotated tag，不自动 push。仅推分支并创建 PR；测试修复后若本地 tag 尚未推送，应先让 tag 指向最终待发布提交，不能移动已公开标签。
2. 通过 PR 质量门禁，以及 `gh workflow run release-macos.yml --ref <分支>` 正式打包预检。手动运行不会公开 Release。验收与边界写在交接/QA，不把 CI 等同于完整 GUI 硬件验收。
3. 合并 main，确认合并后质量检查通过，使用与版本一致的 `vX.Y.Z` annotated tag 指向已合并提交，再 push 该 tag。
4. tag 流水线验证版本、锁文件、说明与五项 Mac Secrets，构建四个独立安装包。任何架构或安装回归失败，publish 都跳过。
5. 验证四份旁置校验和，生成完整 SHA256SUMS；先上传到 draft，再公开并设 Latest。脚本再次验证四包完整和哈希，拒绝覆盖已公开 Release。失败上传保留 draft，允许重跑补齐。

## 四种产物与真实门禁

| 产物 | runner / 检查 |
| --- | --- |
| `TodoCue-X.Y.Z-macOS-arm64.dmg` | macos-26 / 原生 Node、SQLite、Rust、Swift、后台安装与重启 |
| `TodoCue-X.Y.Z-macOS-x64.dmg` | macos-15-intel / 同上 |
| `TodoCue-X.Y.Z-Windows-x64-setup.exe` | windows-latest / Rust、完整运行时、十组 NSIS 安装与恢复检查 |
| `TodoCue-X.Y.Z-Windows-arm64-setup.exe` | windows-11-arm / 同上 |
| `SHA256SUMS` | 四个最终安装文件的 SHA-256 |

Mac 包由 `npm run desktop:macos -- --release` 构建，路径 `apps/desktop/build/`。内置 Node 26.7.0（下载 SHA 固定）、锁定生产依赖、对应 SQLite 扩展、通知辅助程序和 Skill；按内到外 Developer ID 同团队签名。App ZIP 和 DMG 分别提交 Apple 公证，仅接受 `Accepted`，staple、validate 和 Gatekeeper 全通过才上传。临时证书/钥匙串始终清理，公证 JSON 留存 7 天。

Windows 使用 `npm run windows:build -- --release`，对应架构的 Node/SQLite/helper 与离线 WebView2，当前用户 NSIS。暂未配置 Authenticode 证书，正式包明确为未签名；版本说明须保留此信息。生成前清理旧 NSIS 输出，避免缓存混入上版安装器。不能用 x64 外壳或模拟运行代替 ARM64 原生 Node/SQLite SQL 检查。

Mac 安装冒烟 `scripts/smoke-macos-install.mjs` 仅允许可弃用的 GitHub macOS runner，禁止在开发用户运行；Windows 冒烟同样仅用于可弃用用户。两者自建中文/空格数据目录，不操作个人生产数据库。Mac 检查打包副本 bootstrap、CLI 所属目录、附件、幂等、后台重启、非默认端口、卸载保留数据。

## Mac 签名配置

Repository Secrets：`MACOS_CERTIFICATE`（Developer ID Application 含私钥 p12 的 Base64）、`MACOS_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。`scripts/ci-import-apple-signing.sh` 只在可弃用 runner 导入临时钥匙串；缺失、错误团队、开发证书或 ad-hoc 不得用于 release。证书和密码不得提交代码或写入日志。

本地普通 `npm run desktop:macos` 可生成 ad-hoc 测试包；它不是公证正式包。`--release` 强制签名身份、Team ID 与 `TODOCUE_NOTARY_PROFILE`，可通过 `TODOCUE_SIGN_KEYCHAIN` 指定钥匙串。旧 `npm run macos:dmg` 仍用于构建 SwiftUI 回退版本，正式 tag 流水线不再调用它。

## 失败与回退

检查失败只修复/重跑失败项；Apple 处理中或超时要保留提交 ID 与日志，不能跳过公证。已公开版本不可覆盖，新增修复使用新版本。UI 仍未接入自动更新，用户下载替换 App / 运行安装器即可。

共享客户端与 v0.5.x 数据格式兼容。Mac 需要先退出旧客户端再打开新客户端；回退前也先退出共享客户端。更换 App 保留数据及 Apple 同步关联；新版尚未提供 Apple 同步、硬件刘海和全部偏好导入，见[版本说明](../release-notes/v0.6.0.md)。没有 Windows 硬件时继续 CI 构建与安装回归，硬件 GUI / DPI / 通知点击等项必须保留未验收。

## 历史：原 SwiftUI macOS 发布记录

下列记录对应旧版生产客户端与当时测试计数，不表示共享客户端已通过同等硬件验收。

### 当前本地验收（2026-09-07）

- actionlint 1.7.12 工作流校验、Shell 语法检查和 release dry run 通过。
- 发布脚本 17 项、TypeScript 38 项、Swift 33 项测试通过。
- Apple Silicon DMG 重新构建成功，Developer ID 签名验证通过；App 与通知辅助程序均读取 `0.1.0`，最终 DMG 的 SHA-256 与旁置校验文件一致。
- Intel 的 App 与通知辅助程序在本机使用 Xcode 26.5 交叉编译成功；完整 Intel DMG 在下述云端试跑中验收。
- 实际确认 `--release` 缺少公证 profile 时立即失败，既有 DMG 不被覆盖。
- 五个 Repository Secrets 已配置完成。证书导出文件验证包含预期的 Developer ID 和私钥；Apple `notarytool store-credentials` 已验证公证邮箱、专用密码和 Team ID 匹配。专用密码标记为 `TodoCue GitHub Release`，参考项目的 `cc-haha` 密码保留。验证使用的临时证书、密码文件和钥匙串已清理。

### GitHub Actions 验收（2026-09-07）

[首次云端试跑](https://github.com/NanmiCoder/TodoCue/actions/runs/34126522765) 使用提交 `593be20`，通过 `workflow_dispatch` 启动，约 9 分钟完成，结果为 `success`。

- 版本、发布说明、五个 Secrets 检查、发布脚本测试、TypeScript 测试与构建通过。
- Apple Silicon 与 Intel 均在对应架构的 GitHub runner 上通过 33 项 Swift 测试，完成完整打包、Developer ID 签名、App 与 DMG 公证及票据装订。两个架构的内置 Node、SQLite 和 MCP 加载检查均通过。
- 四份 Apple 公证回执（两个架构各自的 App 和 DMG）均为 `Accepted`。
- 下载后的两个 DMG 校验和一致；本机重新验证 DMG 与包内 App 的签名、公证票据和 Gatekeeper 均通过。主程序、通知辅助程序及内置 Node 的架构分别为 arm64 / x86_64，主 App 与通知辅助程序的版本均为 `0.1.0`。
- 手动试跑的安装包保存在 Actions artifacts，不创建公开 Release。推送正式版本标签才会进入发布步骤。

### 首次正式发布（2026-09-07）

推送 `v0.1.0` 标签后，[正式发布工作流](https://github.com/NanmiCoder/TodoCue/actions/runs/34127825697) 的验证、双架构构建、公证和发布任务全部成功。

- [TodoCue v0.1.0](https://github.com/NanmiCoder/TodoCue/releases/tag/v0.1.0) 已发布并设为 Latest，正文与 `release-notes/v0.1.0.md` 一致。
- Release 的 Assets 包含 `TodoCue-0.1.0-macOS-arm64.dmg`、`TodoCue-0.1.0-macOS-x64.dmg` 和 `SHA256SUMS`。
- 首次发布时仓库为 Private；同日已按维护者要求改为 Public，Release 与安装包现可公开访问。

### 日常质量门禁

主分支推送与 PR 运行 `.github/workflows/quality.yml`：Linux 上执行 `npm run check`，macOS 上执行 Swift 测试。版本发布也执行同一套运行时门禁，两种架构分别运行 Swift 测试。

本地统一入口为 `npm run check:macos`；其中 `test:smoke` 使用临时数据库和随机端口，启动真实 CLI/MCP 子进程，验收附件上传、图片读取、提醒事件与持久化重启。它不会读写日常 TodoCue 数据。涉及原生 UI 的变更还需完成 Computer Use 验收；[0.1.1 验收记录](qa/v0.1.1.md) 是本次版本的人工门禁记录。

### 0.1.1 正式发布（2026-09-08）

[发布流程](https://github.com/NanmiCoder/TodoCue/actions/runs/34147845206) 针对提交 `6a06b83` 全部成功，[v0.1.1](https://github.com/NanmiCoder/TodoCue/releases/tag/v0.1.1) 已公开并成为 Latest。

- 本地完整 133 项测试、真实 CLI/MCP 冒烟及 Computer Use 原生验收完成后，先推送主分支；[远程质量门禁](https://github.com/NanmiCoder/TodoCue/actions/runs/34147756979) 成功后才推送标签。
- 两个架构分别通过 51 项 Swift 测试，完成 Developer ID 签名及 App/DMG 公证，四份回执均为 `Accepted`。
- 公开 Release 的双架构 DMG、`SHA256SUMS`、正文和 Latest 状态已核对。下载后，两种 DMG 与包内 App 的签名、票据、Gatekeeper 和版本复核通过。
- 原生用例、截图、通知授权边界和最终安装包校验和见 [0.1.1 验收记录](qa/v0.1.1.md)。
