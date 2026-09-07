# GitHub Actions 发布 macOS App

向 GitHub 推送 `vX.Y.Z` 标签后，`Release macOS` 工作流自动测试、构建、签名、公证并发布两个 DMG。Apple Silicon 与 Intel 分别在对应架构的 GitHub runner 上构建，App 内置的 Node 和 SQLite 扩展也使用相同架构。

## 一次性配置：五个 Repository Secrets

打开 [TodoCue 的 Actions Secrets 设置](https://github.com/NanmiCoder/TodoCue/settings/secrets/actions)，选择 **New repository secret**，添加以下五项。名称与参考项目 `claude-code-haha` 一致；已有证书及相应凭据可以复用，但另一个仓库的 Repository Secrets 不会自动出现在本仓库。

| Secret 名称 | 内容 | 获取方式 |
| --- | --- | --- |
| `MACOS_CERTIFICATE` | 包含证书和私钥的 `.p12` 文件的 Base64 文本 | 从钥匙串访问导出 Developer ID Application 身份，再编码 |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 | 自行设置一个非空密码 |
| `APPLE_ID` | 苹果开发者账户登录邮箱 | 使用所属开发团队的账户 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 给公证工具使用的 App 专用密码 | 在 Apple Account 的登录与安全中创建 |
| `APPLE_TEAM_ID` | 10 位开发团队 ID | Apple Developer 账户的 Membership details |

当前本机已安装 TodoCue 的签名身份为 `Developer ID Application: Shenzhen Yunce Artificial Intelligence Co., Ltd (D3RS24869F)`。如果继续使用这张证书，`APPLE_TEAM_ID` 填 `D3RS24869F`。

`GITHUB_TOKEN` 由 Actions 自动提供。临时钥匙串密码每次运行自动生成，签名指纹从导入的证书中读取；不需要配置额外 Variables 或 `KEYCHAIN_PASSWORD`。本项目通过 GitHub 分发 DMG，当前功能不需要 App Store provisioning profile 或 Tauri updater 密钥。

### 1. 导出签名证书和私钥

1. 打开 macOS **钥匙串访问 → 登录 → 我的证书**。
2. 找到 **Developer ID Application: … (TEAM_ID)**。展开后应能看到对应私钥。Apple Development、Apple Distribution 和 Developer ID Installer 都不是这里需要的身份。
3. 选中包含私钥的证书身份，右键导出，选择 **Personal Information Exchange (.p12)**，例如保存到桌面的 `TodoCue-Developer-ID.p12`。
4. 设置导出密码，将其保存为 `MACOS_CERTIFICATE_PASSWORD`。若没有 `.p12` 导出选项，通常是当前钥匙串中没有该证书的私钥，只有 `.cer` 不足以在 CI 签名。
5. 在终端运行以下命令，把编码结果复制到剪贴板，然后粘贴到 `MACOS_CERTIFICATE`：

```bash
base64 -i "$HOME/Desktop/TodoCue-Developer-ID.p12" | pbcopy
```

也可以直接通过 GitHub CLI 写入该 Secret，避免在终端输出证书：

```bash
base64 -i "$HOME/Desktop/TodoCue-Developer-ID.p12" |
  gh secret set MACOS_CERTIFICATE --repo NanmiCoder/TodoCue
```

证书包含私钥，请保存在项目目录之外；不要把 Base64 内容、`.p12` 或密码提交到 Git。

### 2. 创建公证专用密码

登录 [Apple Account](https://account.apple.com/)，进入 **登录与安全 → App 专用密码**，创建一个例如 `TodoCue GitHub Release` 的密码，并保存为 `APPLE_APP_SPECIFIC_PASSWORD`。这里使用的是专用密码，不是日常 Apple 登录密码。账户需要启用双重认证。

`APPLE_ID` 填登录邮箱；`APPLE_TEAM_ID` 填签名证书所属团队的 ID。两者配合专用密码供 `notarytool` 验证。参考 [Apple 的 notarytool 凭据说明](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)和[自定义公证流程](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)。

其他四项也可用交互式命令录入，不必把密码放进命令历史：

```bash
gh secret set MACOS_CERTIFICATE_PASSWORD --repo NanmiCoder/TodoCue
gh secret set APPLE_ID --repo NanmiCoder/TodoCue
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo NanmiCoder/TodoCue
gh secret set APPLE_TEAM_ID --repo NanmiCoder/TodoCue
```

## 发布版本

版本唯一来源是根目录 `package.json`。工作区包版本、内部包依赖、`package-lock.json` 和 `RUNTIME_VERSION` 由发布脚本同步；App 和通知辅助程序的 Info.plist 版本在构建时读取根版本。

先把准备发布的代码提交好，并写好目标版本说明。当前已附带 `release-notes/v0.1.0.md`，应在首次发布前核对内容。

首次发布当前 `0.1.0`：

```bash
npm run release:check
npm run release -- 0.1.0 --dry
npm run release -- 0.1.0
git push origin main v0.1.0
```

下一次发布补丁版本，例如 `0.1.1`：

```bash
# 先编写 release-notes/v0.1.1.md
npm run release -- patch --dry
npm run release -- patch
git push origin main v0.1.1
```

也支持 `minor`、`major` 或明确的 `x.y.z`。非 dry 模式会更新版本文件、创建 release commit 和 annotated tag；如果当前版本已全部提交，只创建标签。脚本不自动 push，并输出当前分支及本次标签的准确 push 命令。除目标发布说明外，工作区必须干净，防止把其他暂存内容带入 release commit。

如选择手动 `git tag`，也必须先通过 `npm run release:check -- vX.Y.Z`。CI 不替你猜测版本，也不自动生成发布说明；版本错配、缺少说明、预发布标签如 `v1.0.0-beta.1` 都会失败。当前只支持稳定版 `vX.Y.Z`。

## 工作流做什么

1. 在 Linux runner 检查标签、版本镜像、发布说明及五个 Secrets，运行 TypeScript 和发布脚本测试。
2. 使用 `macos-26` 构建 `arm64`，`macos-15-intel` 构建 `x64`；两边固定 Xcode 26.2 和 Node 26.7.0，并运行 Swift 测试。
3. 在临时钥匙串中导入 `.p12`，确认身份类型和 Team ID，验证并保存公证凭据。证书导入遵循 [GitHub macOS runner 指南](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)。
4. 从锁文件安装依赖，使用固定 SHA-256 的官方 Node，给 SQLite 扩展、Node、通知辅助程序和主 App 逐层签名。
5. 提交 App 压缩包公证，只接受 Apple 的 `Accepted` 结果，给 App 装订票据后再生成 DMG；DMG 自身也签名、公证和装订。两者都经过 `stapler validate` 和 Gatekeeper 检查。
6. 两种架构均成功后，下载产物、核对最终 DMG 的 SHA-256。先向 draft Release 上传全部文件，上传成功后才公开发布。
7. 无论成功或失败，都清理临时钥匙串和证书。公证结果和 Apple 诊断日志作为短期 Actions artifacts 留存。

GitHub 当前提供的 runner 标签见[官方列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，所选 Xcode 的可用性见 [macOS 26 ARM64 镜像](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)和 [macOS 15 Intel 镜像](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md)。以后升级 Xcode 或 Node 时需一起核对工作流和打包脚本。

最终 Release 包含：

```text
TodoCue-X.Y.Z-macOS-arm64.dmg
TodoCue-X.Y.Z-macOS-x64.dmg
SHA256SUMS
```

App 内尚未接入自动更新；这里自动化的是构建和 GitHub 分发。

## 第一次试跑与失败处理

把工作流提交到 GitHub 默认分支、配置好 Secrets 后，可在 **Actions → Release macOS → Run workflow** 试跑。手动运行同样要求签名和公证成功，结果保存在 Actions artifacts（14 天），不会自动创建公开 Release；无需为试跑发布真实 Tag。

- **缺少 Secret**：最前面的检查会列出名称，不会启动昂贵的 macOS 构建。
- **证书导入失败或没有有效身份**：检查 Base64 是否完整、`.p12` 密码和私钥是否正确、证书是否过期。
- **Team ID 不符或身份类型错误**：检查导出的是指定团队的 Developer ID Application。
- **公证认证失败**：检查 Apple 邮箱、专用密码、团队权限和开发者协议状态。
- **公证被拒绝或超时**：查看 `notarization-arm64` / `notarization-x64` artifacts 中的 submission 与 Apple 日志。每次提交最多等待 30 分钟，超时不会发布；Apple 可能仍在处理，应先用提交 ID 查询结果，再决定是否重跑。
- **只成功一种架构**：不会公开不完整 Release；修复后重跑失败任务。
- **上传中断**：Release 保持 draft，重跑发布 job 可补齐产物。已公开的 Release 不会被脚本覆盖，后续更改使用新版本和新标签。

本地检查：

```bash
npm run test:release
npm run release:check
npm test
swift test --package-path apps/macos
npm run macos:dmg
```

本地普通打包仍允许临时签名。`npm run macos:dmg -- --release` 强制要求 Developer ID、公证 profile 和正确的 `APPLE_TEAM_ID`，不会自动降级。本地配置自定义钥匙串时，通过 `TODOCUE_SIGN_KEYCHAIN` 指定；默认钥匙串的既有 `TODOCUE_NOTARY_PROFILE` 继续可用。

完成本地测试不等于已经通过 Apple 公证或验证了 Intel 安装。首次配置 Secrets 后的 Actions 试跑仍是整个云端流程的实际验收。

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
