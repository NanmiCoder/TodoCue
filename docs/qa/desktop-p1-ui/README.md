# 共享 UI 校准与 Windows 安装验证

2026-10-14。代码基准 `fdb8ce3`，分支 `codex/desktop-native-ui-fixes`，原交接提交 `2bf7349`。[草稿 PR #17](https://github.com/NanmiCoder/TodoCue/pull/17) 的目标分支是 `codex/desktop-migration-handoff`。没有合并主分支、升级版本或发布正式包。

本机 Apple Silicon / macOS 26；全部本地 UI 操作使用 `TODOCUE_HOME=/tmp/todocue-desktop-native-ui-fixes-20261014`，运行时端口 47832，Ego Lite 端口 5173。没有使用个人生产数据库。报告只保存布局/行为测量和测试文本，不保存连接 token 或数据库。

## 按 SwiftUI 修正的体验

以实际运行的原客户端及 `TaskFormView.swift`、`TaskDetailView.swift`、`CalendarView.swift`、`DialKit.swift`、`DesignComponents.swift`、`NotchView.swift` 为基准，继续使用 React/Tauri 和原任务契约。

| 部分 | 修正后的行为 |
| --- | --- |
| 原生焦点 | 面板显示/固定时同时激活宿主窗口和 WebView first responder；刘海收起释放 first responder。箭头提交在按钮进入禁用状态前同步把焦点交回输入框，随后尊重 Tab、其他控件和收起操作 |
| 表单输入 | 19pt 标题自动增长至 2–4 行，13pt 备注至 2–6 行，重新排版响应窗口宽度和字体加载；Cmd/Ctrl+Enter 不重复提交，composition/229 不保存 |
| 草稿 | 空白完整表单默认未安排；继续输入恢复草稿；有快速输入时创建新草稿；从日历新建时使用选中日期。提交中编辑和附件移除继续按原保存会话处理 |
| 属性与附件 | 日期、项目、优先级、耗时和附件数呈现当前值及淡色描边，各自可清除；已创建任务不改重复规则。图片按原版列数组成缩略图，文件整行显示；预览支持焦点约束、Esc 返回及焦点恢复 |
| 日历 | 月/周/折叠、前后导航与点击标题回今天；中文周一开头，英文按区域周规则。待办计划、已完成历史和截止标记分别计算；历史默认折叠，待生成占位不提供任务操作 |
| Dial | 数字按位滚动并保留未变前缀，表盘面和指针随同一连续进度更新，只有完成计数实际增加触发波纹；完成反馈等待 420ms 再写入 |
| 系统偏好 | 减少动态效果实时订阅媒体变化，不重挂编辑页面；关闭位移/缩放/布局运动，保留短淡入。减少透明度使用实色背景；移除 hover 直接位移的遗漏 |

## 实测通过

| 检查 | 范围与证据 |
| --- | --- |
| 页面布局 | [448 条测量](layout-pages.json)：中/英文 × 明/暗 × 正常/减少动效 × 300/340/480/600 宽 × 14 个页面状态，高 680。覆盖今日、即将到来、全部、详情、编辑/长表单、日期弹层、月/周/折叠日历、已完成、周期列表/表单、设置 |
| 附件与表单布局 | [160 条测量](layout-attachments.json)：同一完整矩阵 × 详情、编辑、长表单、日期弹层、图片预览。实际媒体匹配、无横向溢出、底部操作可见；预览 Esc 返回表单 |
| 最小高度 | [24 条测量](layout-short-window.json)：中/英文 × 300/600 宽 × 今日、详情、表单、弹层、短窗口日历、周日历，高 360。滚动后可操作内容和底部按钮可见 |
| 动态偏好/冲突/输入 | [真实行为结果](behavior.json)：编辑中切换深色、减少动效及减少透明度后标题保留，背景为 `rgb(42,44,48)`，属性弹层位移 0/缩放 1；合成 229 键产生 0 次写入。外部真实 PATCH 制造版本冲突，保存显示 reload 操作且保留标题；读取最新版本通过 |
| 箭头提交继续输入 | 浏览器延后真实创建响应，未重新点击输入就全选并输入下一条，返回后文本完整；最初测试用了 macOS 的 Control+A（移至行首），改用 ControlOrMeta+A 后通过。此项为测试快捷键修正 |
| macOS 面板/刘海 | 最终 `fdb8ce3` Preview 在箭头后直接输入通过；分别暂停隔离服务，箭头后不点击输入直接 Cmd+A/粘贴下一条，响应前后草稿均完整且聚焦。REST 确认已提交标题各只有一条，下一条未提交草稿各为 0 条 |
| macOS 完整表单/附件 | 原生填写并创建真实任务、附件缩略图与属性值通过；打开图片预览，Esc 回到表单通过。输入、粘贴、双回车去重、两阶段 Esc 和原生保存中 Tab 的更早证据见 [P0 记录](../desktop-native-ui-fixes/README.md) |

448 条矩阵在 `1e75981` 开始，日历语义修正在期间加入；160 条矩阵使用 `c7fca25`，24 条短窗口与最终行为复测使用 `fdb8ce3`。后续焦点和实时偏好变更未改变这些页面的布局；这里不把测量次数等同于原生页面逐像素验收。

完成写入时间实测约 423ms、真实响应约 476ms。[逐帧采样](motion-sampling-inconclusive.json) 约每秒才取得一帧，只能确认最终数字/表盘状态与延后写入，**连续动画的逐帧一致性尚未验证**。不能把这组低频采样标成动效通过。

## 原版与 Preview 实际窗口

以下来自实际 SwiftUI/AppKit 与 Tauri/WebView 窗口，同一隔离数据库、同一天、340×680 逻辑尺寸，截图为 680×1360。截图时共有 31 条待办、1 条完成；后续输入回归又增加了测试任务，因此下面的焦点截图计数不同。原版编辑标题的橙色区域是文本选择状态。Tauri 截图代码 `dd78a0d`，最终 `fdb8ce3` 焦点修正未改变布局。

| 页面 | SwiftUI 原版 | Tauri Preview |
| --- | --- | --- |
| 首页 | ![SwiftUI 首页](home-swiftui-macos.jpg) | ![Tauri 首页](home-tauri-macos.jpg) |
| 表单 | ![SwiftUI 表单](form-swiftui-macos.jpg) | ![Tauri 表单](form-tauri-macos.jpg) |
| 详情 | ![SwiftUI 详情](detail-swiftui-macos.jpg) | ![Tauri 详情](detail-tauri-macos.jpg) |
| 日历 | ![SwiftUI 日历](calendar-swiftui-macos.jpg) | ![Tauri 日历](calendar-tauri-macos.jpg) |

焦点证据：[面板立即继续输入](panel-immediate-input-macos.jpg)、[面板延迟响应后草稿](panel-pending-draft-macos.jpg)、[刘海延迟响应后草稿](notch-pending-draft-macos.jpg)。另有 [英文深色图片预览](attachment-preview-en-dark.png)。

字体渲染、SF Symbols/SVG、系统玻璃和原生 Quick Look 与共享图片预览仍有平台差异；没有宣称逐像素相同。当前原生对照覆盖以上四页和 P0 刘海，不能代替所有主题/语言/状态的原生对照。

## Windows 两种架构：实际安装包通过

代码 `fdb8ce3` 的 [Desktop preview CI](https://github.com/NanmiCoder/TodoCue/actions/runs/38557490723) 全部通过。x64 使用 Windows Server 2025 Datacenter 10.0.26100 的 `windows-latest` runner；ARM64 使用 Microsoft Windows 11 的 `windows-11-arm` runner。不是 Windows 10 桌面 GUI 验收。

两种架构分别构建真正的 NSIS 包，并用包内 Node/CLI/SQLite 在中文含空格的隔离目录完成七组检查：

1. 静默安装，文件齐全、Node 架构匹配、原生 SQLite 实际执行 SQL。
2. 当前用户计划任务启动自定义目录运行时，CLI shim 指向安装后的 runtime。
3. 包内 CLI 和已安装 shim 创建、读取附件，幂等重试返回同一任务。
4. 已安装 MCP stdio initialize、发现工具、读取任务，stdin EOF 正常退出。
5. 后台停止/启动后任务和附件保留。
6. 静默重装停止并恢复已登记自定义目录运行时；只轮询健康，不由测试主动启动掩盖恢复失败。
7. 卸载清理服务、CLI、受管理 PATH，保留 SQLite 数据库。

| 架构 | 安装包及 SHA-256 产物 | 安装冒烟 JSON |
| --- | --- | --- |
| x64 | [预览产物](https://github.com/NanmiCoder/TodoCue/actions/runs/38557490723/artifacts/11891571662) | [七组检查报告](https://github.com/NanmiCoder/TodoCue/actions/runs/38557490723/artifacts/11891271820) |
| ARM64 | [预览产物](https://github.com/NanmiCoder/TodoCue/actions/runs/38557490723/artifacts/11891556896) | [七组检查报告](https://github.com/NanmiCoder/TodoCue/actions/runs/38557490723/artifacts/11891362054) |

这是 GitHub Actions 临时预览产物，需要仓库访问权限，按 artifact 保留策略过期；不是正式 Release。可重新触发 workflow 重建。

CI 暴露并修复了通知助手平台路径、动态导入文件 URL、Cargo CRLF、图标格式、测试时区、NSIS 不携带工作区 junction、模块搬迁改变 runtimeRoot、数值 SID 的权限授权，以及升级任务已启动但健康尚未就绪的验收竞态。工作区入口改为普通目录和转发文件，保留原模块 URL；搬迁后导入回归通过。数值 SID 按 [Microsoft icacls 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls) 加 `*` 前缀。

## 质量检查与剩余边界

- 本地 `npm run check`：25 文件 / 175 个 Vitest、21 个脚本测试、CLI/MCP 冒烟和 release check 通过；版本仍为 0.5.3。
- `desktop:check`：前端构建及 Rust 11+5 测试通过；最终源码 macOS debug Preview 包构建通过。Windows 的 Rust 测试额外运行 3 个平台测试，两种架构都通过。
- [Quality gates](https://github.com/NanmiCoder/TodoCue/actions/runs/38557490649)：Linux 完整检查通过；完整 Xcode 26.2 的 Swift Apple Silicon 275 个测试（4 跳过）、Intel 275 个（11 跳过）均 0 失败。Intel VM 无可用 GPU，跳过原生动画窗口测试；截图测试为显式 opt-in。本地只有 CLT，缺 XCTest 的限制没有被写成通过。
- Windows 的 Vitest 为 174 通过/1 跳过，脚本为 16 通过/5 跳过，平台专属跳过与本地数字不同；不能把跨架构构建写成全部 GUI 行为通过。
- macOS AX 控件动作与原生键盘已验证；物理鼠标外部点击、拖选、候选窗口、透明命中、原生悬停时序、多屏/全屏/休眠仍未完成。原生坐标工具无法取得刘海可点击窗口；其他应用定向操作没有可靠全局鼠标证据。
- Windows GUI、通知点击冷/热启动、离线 WebView2 的干净机安装、多屏/DPI/任务栏、IME、全屏/休眠及提醒并发的实机行为未验证。
- macOS Intel 的 Tauri 包、真实硬件刘海、EventKit 桥接、偏好导入和生产客户端切换仍是后续迁移项。

下一次验证先跑 [交接清单](../../desktop-handoff.md) 中这些实机项；不重复已通过的打包修复，也不以缺设备要求重写任务引擎、API 或数据库。
