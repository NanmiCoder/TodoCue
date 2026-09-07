# macOS 安装与数据保留

## 使用 DMG

1. 打开与 Mac 芯片匹配的 DMG（`arm64` 为 Apple Silicon，`x64` 为 Intel）。
2. 将 `TodoCue.app` 拖到 `Applications`。
3. 从 `/Applications/TodoCue.app` 打开。首次启动会自动配置后台服务与 CLI；不需要另行安装 Node。
4. 在 App 设置的“通知”中请求授权，允许 TodoCueNotifier 通知。

首次启动若提示有另一个开发运行时，请停止之前的 `todocue serve` 后重试。不要直接从挂载的 DMG 内运行日常后台服务。

App 本体和辅助程序位于 `/Applications/TodoCue.app`。Node、生产依赖、CLI 在 App 的 `Contents/Resources/runtime`，通知辅助程序在 `Contents/Helpers`。`~/.todocue/bin/todocue` 指向安装版 CLI；若 PATH 没找到命令，可直接使用这个绝对路径。

后台服务由 `~/Library/LaunchAgents/com.todocue.runtime.plist` 管理，登录时运行、异常退出后重启。关闭面板或退出 App 不会停止后台提醒。App 升级后再次打开，会检查构建标识并更新运行时。菜单栏界面是否登录时出现，由设置中的“登录时启动”控制。

## 数据位置

面板默认宽度为 340 点。拖动左边缘的细条或窗口边缘可在 300–600 点之间调整，双击细条恢复默认宽度。宽度会自动记住，关闭面板、退出或更新 App 后再次打开仍保留；文字与按钮会随宽度重新排布。界面偏好使用 macOS 的应用偏好存储，任务数据库位置如下。

这里的 `~` 是当前用户的主目录，例如 `/Users/nanmi`，不是磁盘根目录 `/`。

```text
~/.todocue/
├── todocue.sqlite       任务、重复系列、提醒、配置
├── todocue.sqlite-wal   SQLite 运行中的写入日志（可能存在）
├── todocue.sqlite-shm   SQLite 共享状态（可能存在）
├── backups/            迁移前备份、手动导出
├── logs/               后台服务日志
├── token               本机接口认证信息
├── connection.json     当前后台服务连接信息
├── runtime-install.json 已安装运行时的构建标识
└── bin/todocue         CLI 启动入口
```

App 初始化、更新和服务卸载都不会删除数据库或重新生成已有认证信息。把 App 移到废纸篓后，以上用户目录仍保留；重新安装 App 到 Applications 并打开，就继续读取原来的任务。系统用户不同则各自拥有独立数据。

不要让清理工具同时删除 `~/.todocue`，否则无法保留数据。App 设置的“数据存储”显示实际目录，并提供打开文件夹的按钮。开发或隔离使用可设置 `TODOCUE_HOME`，所有客户端需指向同一目录。

## 备份

通过 App 菜单“导出 JSON”，或执行：

```bash
~/.todocue/bin/todocue export -o "$HOME/Desktop/TodoCue-backup.json"
```

数据库结构迁移前会自动创建一致的 SQLite 备份。手动复制整个数据目录前，先用 `todocue service stop` 停止后台服务，复制完成后用 `todocue service start` 恢复；不要只复制运行中数据库的主文件而遗漏 WAL。JSON 导出供查看和留档，当前没有一键 JSON 导入功能。

## 卸载与重新安装

如需连后台服务一起卸载，在删除 App 前执行：

```bash
~/.todocue/bin/todocue service uninstall
```

然后把 App 移到废纸篓。该命令只停止并移除 LaunchAgent，保留任务数据。重新安装后首次打开会恢复服务。CLI 启动入口在 App 缺失期间不可用，重装时自动修复。

## 构建

```bash
npm install
npm run macos:dmg
```

构建产物：`apps/macos/build/TodoCue-<version>-macOS-<arch>.dmg`。在对应架构的 Mac 上构建；当前本机验证的是 Apple Silicon。

官方 Node 版本与 SHA-256 固定在 `scripts/package-macos.mjs`，生产依赖来自 npm 锁文件；构建会检查主程序仍为原生 Mach-O、验证签名，并在受限 PATH 下加载内置 Node、SQLite 和 MCP。

构建默认选择本机可用的 Developer ID；可以通过 `TODOCUE_SIGN_IDENTITY` 指定签名身份。没有 Developer ID 时使用临时签名。公开下载分发需要公证：将已有凭据保存为 notarytool keychain profile，然后设置 `TODOCUE_NOTARY_PROFILE` 运行打包；脚本会分别公证 App 和 DMG、装订票据并验证，凭据不会写进项目。

GitHub Actions 的 Tag 自动发布、五个 Secrets 和版本同步步骤见 [GitHub 发布指南](github-release.md)。正式 CI 构建启用 `--release`，缺少正确的签名身份或公证配置时会直接失败。
