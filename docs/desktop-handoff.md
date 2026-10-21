# TodoCue 跨平台客户端开发交接

**2026-10-16 正式分发已完成：** [v0.6.0](https://github.com/NanmiCoder/TodoCue/releases/tag/v0.6.0) 已作为公开、非预发布的 Latest 发布，源码 `62a4d16` 已合并 main。正式客户端为共享 React / Tauri，Mac ARM64/Intel 与 Windows x64/ARM64 四包及 SHA256SUMS 齐全；[正式流水线](https://github.com/NanmiCoder/TodoCue/actions/runs/38916287661)第 2 次执行全通过。Mac App/DMG 的 Developer ID、公证、staple、验证和 Gatekeeper 通过；两个 Mac runner 的独立运行时回归及两个 Windows runner 的各十组真实 NSIS 安装检查通过。Windows 安装包未做 Authenticode 签名。当前本机已安装与公开校验和相同的 Mac ARM 通用版，无参数重开恢复原隔离任务与自定义端口。详见[正式分发验证](qa/desktop-stable-release/README.md)。Apple 同步、硬件刘海、全部偏好导入及完整原生 GUI/逐帧验收仍保留；以下旧 Preview/外部后台说明属于历史。

以下 2026-10-14/15 的记录属于 Preview 历史；本文件继续列出未完成的功能与硬件验收，不将正式分发等同于迁移全部交付。

本轮从交接提交 `2bf7349` 建立隔离工作树与 `codex/desktop-native-ui-fixes`，[PR #17](https://github.com/NanmiCoder/TodoCue/pull/17) 已按用户授权合并到 `codex/desktop-migration-handoff`（`a57d012`）。此前代码 `7ad1b95`（UI 修复基准 `fdb8ce3`）已完成刘海/面板输入修复、表单/附件/日历/Dial 校准及 Windows 双架构安装包冒烟。见 [P0 证据](qa/desktop-native-ui-fixes/README.md) 和 [完整 UI / 构建验证记录](qa/desktop-p1-ui/README.md)；真实鼠标、IME 与 Windows GUI 等未验证项仍保留。

**2026-10-15 独立审查修复：** 原审查13项已有实现修复，并补上CLI目录/端口、日历、普通Return、Pin、图片、逾期、提醒容量、被动窗口与安装恢复回归。三个subagent再次独立复审，主代理完成Ego/原生/真实API复测；最新源码为 `50762d4`。见 [本轮修复与证据](qa/desktop-review-fixes/README.md)。Windows双架构新增十组安装及恢复故障测试均已实测通过，实机与正式macOS迁移项仍未完成；不将全绿CI或布局计数当作正式发布/完全复刻。

**合并后构建：** [PR #18](https://github.com/NanmiCoder/TodoCue/pull/18) 补齐共享 Mac 双架构 release App，七项 CI 通过后合并到交接分支（`3bb8ceb`）。Windows x64/ARM64 NSIS、共享 Mac Apple Silicon/Intel App ZIP、原 SwiftUI 双架构 Developer ID 公证 DMG 均已生成。[六种产物下载、源码记录、测试和边界](qa/desktop-builds/README.md)已整理。共享 Mac 仍需要外部隔离运行时；main 和正式 Release 未改变。

**2026-10-16 Mac 直接打开离线修复：** 后台健康，但直接打开 App 未携带隔离目录参数，旧版回到临时开发目录并一直显示“后台服务未连接”。release Preview 现在记住显式选定的目录，Finder/Dock 重开自动复用；开发 debug 保持隔离默认。已在本机替换修复版，确认无参数/无环境变量直接打开恢复原任务，回车创建只持久化一次。见[原因、7 项新回归及实测](qa/desktop-macos-runtime/README.md)。这不替代 Mac 运行时正式打包。

## 代码从哪里继续

- 仓库：<https://github.com/NanmiCoder/TodoCue>；共享正式客户端已由 [PR #20](https://github.com/NanmiCoder/TodoCue/pull/20) 合并 main（`1050bb1`）。PR #21 将 CI 修复合并到 `62a4d16`，最终 tag `v0.6.0` 指向该提交；源码、构建/安装与发布结果见[正式分发验证](qa/desktop-stable-release/README.md)。
- 后续功能或修复从最新 `origin/main` 建立新的隔离 `codex/` 分支；需要精确复现 0.6.0 时从 `v0.6.0` 建立。若用户明确指定其他基准，遵从该指令。同名分支存在时先检查并复用或换名，不重置已有修改。
- 原交接 `origin/codex/desktop-migration-handoff` 与提交 `2bf7349` 保留历史。本轮最初确实先 fetch、从用户指定交接基准建立 `codex/desktop-native-ui-fixes` 新工作树；后续 PR #17/#18/#19 合并交接分支，正式分发由 PR #20 进入主干。旧交接分支不包含全部正式分发实现。
- 原主工作区保持不变；测试使用隔离 TODOCUE_HOME。本机依赖、服务、临时数据库和构建文件不会随 Git 转移。
- 用户已明确授权本轮 merge 与 Win/Mac 正式 release；此前阶段顺序中的生产切换限制已被本次发布指令更新。下面未实现/未验收项目继续保留，发布并不意味着全部 SwiftUI 效果或硬件验收完成。

先阅读仓库 `AGENTS.md`、本文、[实现与验收记录](desktop-migration.md)、[Dial 设计与动效规范](design/dial.md)、[桌面启动说明](../apps/desktop/README.md)。比较 UI 时以现有 SwiftUI 源码和实际画面为准。

## 已确定的产品方向

1. React + TypeScript + CSS/Motion 负责共享前端，Rust + Tauri 2 负责窗口与系统接入；任务引擎、SQLite、API、CLI/MCP 继续复用。
2. 保留现有设计、交互和动效；SwiftUI 源码需移植，但用户不接受重新设计成另一套 UI。优先视觉和使用体感一致，弹簧参数按原版校准。
3. 两端正式分发共享前端；原 SwiftUI 源码与 v0.5.3 回退保留，用于尚未接入的 Apple 同步及功能/视觉对照。
4. Windows 10/11 x64、Windows 11 ARM64；macOS 14+、Intel 和 Apple Silicon。ARM64 验收包含 Node、SQLite、通知程序，不能只检查外壳。
5. Windows 使用顶部虚拟刘海，顶部任务栏时按工作区顶部定位。macOS 保留原生玻璃和原生能力；Apple 同步只在 Mac 提供，本次不新增云同步或 Windows 日历集成。
6. 数据仍本机保存并兼容 `TODOCUE_HOME`；Windows 默认 `%USERPROFILE%\.todocue`。提醒由独立后台服务投递，退出 UI 后仍有效。
7. 用户暂时没有可接入的 Windows 设备，将后续自己测试。先完成本机可验证的实现；硬件缺失不作为要求用户再次提供设备的理由，也不能据此宣称 Windows 通过。

## 已有实现：接着改，不要从头重写

| 位置 | 内容 |
| --- | --- |
| `apps/desktop/src` | 今日/即将到来/全部、详情、表单、日历、历史、周期提醒、附件、设置（含 macOS「同步」）、刘海，以及共享 token、图标、日期、草稿和拖动逻辑 |
| `apps/desktop/src-tauri/src/lib.rs`、`platform.rs` | Tauri 窗口、托盘、快捷键、尺寸记忆、玻璃、显示器定位、原生鼠标/焦点接入 |
| `apps/desktop/src-tauri/src/runtime.rs`、`packages/client` | 宿主代理 REST/SSE，token 保持在宿主；便携类型化客户端；原 server 客户端保留 `fromHome()` 兼容入口 |
| `packages/cli/src/windows-service.ts`、`windows-integration.ts` | 当前用户后台计划任务、自定义目录登记、服务升级/停止/卸载、CLI 与 PATH 管理 |
| `apps/desktop/src-tauri/src/bin`、`windows_home.rs` | CLI 转发、后台进程监督、Windows 通知、按目录标识路由冷/热启动 |
| `scripts/package-windows.mjs`、`stage-runtime.mjs` | 对应架构 Node/SQLite/辅助程序、NSIS、离线 WebView2、Skill 与包校验 |
| `.github/workflows/desktop-preview.yml` | Windows x64/ARM64 完整构建、NSIS 十组安装/恢复检查；Mac Apple Silicon/Intel 检查、release 共享 App 和 ZIP；最新四项 CI 全通过 |

审查确认的八项缺陷已实现修复及回归测试：自定义目录升级/卸载遗漏、四条周期提醒同时领取丢失系统回退、保存期间移除附件又复现、旧已完成查询覆盖新状态、精确截止时间的改期确认遗漏、服务新配置仍运行旧宿主、自定义目录通知启动到错误目录、卸载残留 CLI/PATH。详见实现记录中的证据表；安装、当前用户计划任务、CLI/MCP、升级/卸载已在两个 Windows runner 实测，通知点击及 GUI 行为仍需独立验收。

另修复开发代理丢失 DELETE 请求体的问题，真实代理→HTTP→运行时测试覆盖任务/附件删除。不要删除这些回归测试或为使构建通过而改变 API/数据库契约。

## 首先完成：刘海交互与输入（P0）

用户报告：展开刘海后点击其他区域不会收起；快速输入出现橙色矩形边框；收起刘海落在菜单栏下方；整体 UI/交互体感明显弱于原 SwiftUI。

本次已经做的调整：

- macOS 虚拟刘海锚定屏幕顶部，按菜单栏高度设置收起高度，窗口层级 `NSStatusWindowLevel + 1`；Windows 仍锚定工作区。布局单测与本机收起截图已核对。
- 刘海输入改为 36 高的圆角胶囊、容器细描边、26 加号和单独提交按钮；移除 input 的矩形 outline。面板快速输入、搜索、正文输入也做了相应调整。
- macOS 增加 AppKit 本地/全局鼠标点击监听，外部点击只关闭快览，保留草稿和提醒堆叠。原交接机器曾观察到实际坐标点击其他应用窗口后收起、重新展开草稿保留；本轮物理鼠标验收仍待完成。
- 鼠标离开与外部点击采用不同规则；已有文字不再永久阻止离开收起。原生输入不使用 WebView blur 直接关闭；Windows 失焦路径还检查指针是否在窗口外，尚无实机验证。

**尚未完成的验证和需要调查的问题：**

原交接中原生完整回车创建未通过。本轮最终 Preview 已验证英文输入、中文粘贴、⌘A 替换、双回车只创建一次、加号聚焦、Esc 先清草稿再收起，以及打开主面板后的草稿保留；另连续三轮快速展开/立即粘贴/双回车通过。发现并处理了展开窗口不可接收键盘、异步激活与输入挂载的焦点衔接，以及退出 Motion 内容仍留在 AX 树中可被选中的问题。退出层现在立即 inert/aria-hidden，收起会取消焦点补偿。同步锁与编辑代次同时覆盖面板和刘海快速添加。

**P0 仍是部分完成，不能关闭全部验收项。** 本机原生坐标工具对刘海报 `noWindowsAvailable`；其他应用的定向自动化操作未提供可靠的全局物理鼠标证据。真实外部点击、鼠标拖选、输入法候选窗口、透明命中和原生悬停延迟仍待设备操作确认。浏览器悬停/离开、外部点击/草稿、延迟保存/同名输入、503 反馈、IME 229 键以及提醒/SSE 保留均有本轮验证，不能替代这些原生项。

最终 `fdb8ce3` 还修复面板已激活但 WebView 未取得 first responder，以及箭头提交按钮禁用后才恢复焦点的竞态。现在原生显示/固定同时激活窗口和 WebView，箭头提交同步交回输入，再进入保存状态。最终原生面板和刘海分别暂停隔离运行时、箭头提交后不重新点击输入直接 Cmd+A/粘贴下一条，恢复服务前后完整草稿和焦点均保留；双回车只创建一条，下一条未提交文本未写入数据库。保存中 Tab 转向其他按钮、不被响应抢回，以及请求超时原草稿幂等重试的更早证据保留。临时诊断全部移除。

建议调查顺序：

1. 分别用鼠标悬停、点击收起条、点击输入/加号进入快览；实际点击输入后输入中文/英文、粘贴、选择文本、连续回车创建，核对焦点与持久化数据。
2. 若真实操作仍失败，检查 `Notch.tsx` 的焦点补偿/退出层、hover/leave timer、`quickAdd.ts` 的请求和编辑代次，以及 `lib.rs` 的 focusable/set_focus 顺序；检查 `platform.rs` 的全局/本地事件源和窗口号。
3. 若加诊断，记录是哪条路径引发关闭，不要仅凭失焦推断外部点击；提交前移除临时日志。上一轮临时 `QA mouse` 输出已删除。
4. 原生 AX 树可能先于 0.36 秒窗口扩张出现；仅凭元素已出现在树中不能确认输入位置已进入窗口。验证工具的 AX click 与真正坐标鼠标点击也有差异，不能用菜单 AX action 证明全局 mouse monitor。
5. 逐条复测下面验收要求；在没有完整证据前不要扩大成新的 UI 重写或宣称问题全部解决。

P0 验收：

- 悬停约 200ms 展开，离开约 350ms 收起；点击后固定，编辑期间保持展开。
- 点击刘海内部控件、文本选择、中文输入法候选和粘贴不会意外关闭；回车只创建一次，保存时继续输入不丢下一条草稿。
- 点击其他应用、桌面或本应用的另一窗口能收起快览，即使有草稿/已固定；重新展开保留未提交草稿。
- Esc 先清草稿，再收起；关闭快览不清除提醒堆叠。新提醒、延迟回执和 SSE 到达不能破坏这套状态。
- 不抢悬停/提醒的键盘焦点，不让透明空白遮住桌面点击；保存和网络失败有可见反馈。

## 后续工作顺序与完成条件

### P1：按原版完成 UI 和动效对照

- [x] 校准刘海/快速添加、自动增长输入、属性值与清除操作、附件画廊/预览、详情和月/周日历；按原版实现按位数字、连续表盘进度、完成反馈与实时减少动效。
- [x] 同一隔离数据库下保存 SwiftUI / Tauri 首页、表单、详情、日历的实际窗口对照；另有 P0 刘海对照。
- [x] Ego Lite 448 条页面矩阵、160 条附件矩阵、24 条最小高度检查通过；实际核对媒体匹配、横向溢出、底部操作。中英文、明暗、两种动效、300/340/480/600 宽覆盖见 QA 记录。
- [x] 真实延迟保存、同名输入、版本冲突保留/读取最新、附件移除、草稿隔离、229 确认键、实时偏好保留编辑会话等行为回归；已有拖动改期/撤销、断线/旧响应测试保留。
- [ ] 所有页面状态的原生主题/语言视觉验收，Windows 原生布局与玻璃差异。
- [ ] 逐帧对照数字滚动、表盘波纹、切页、拖动/撤销、刘海展开与提醒堆叠。完成写入实测约 423ms；Ego rAF 约每秒一帧，采样连续性不足，不标成逐帧通过。
- [ ] 真实鼠标文本选择、输入法候选窗口与附件粘贴等系统交互。

### P2：Windows 构建、安装与实机验证

- [x] x64 / ARM64 完整检查、Rust 测试、对应 Node/SQLite/helper、NSIS 构建；修复路径、文件 URL、CRLF、图标、时区、工作区 junction、模块根目录、数值 SID 与升级就绪竞态；后续为重复 WebView2 断连加三次限次重试，并淘汰空 Rust 缓存。
- [x] 此前实际安装包的七组冒烟：静默安装、Node 架构/SQLite SQL、自定义中文空格目录/当前用户计划任务、包内 CLI 与 MCP、后台重启、重装恢复、卸载清理并保留数据库。
- [x] 整理 [CI 与 x64/ARM64 预览下载](qa/desktop-p1-ui/README.md#windows-两种架构实际安装包通过)。x64 runner 为 Windows Server 2025，ARM64 为 Windows 11；不能据此宣称 Windows 10/11 的完整 GUI 通过。
- [x] 最新50762d4两架构十组安装冒烟：无home参数shim、端口保留、恢复失败/不健康、数据与恢复标记保留及重试。见[本轮证据](qa/desktop-review-fixes/README.md)。
- [ ] 干净 Windows 10/11 x64、Windows 11 ARM64 离线 WebView2 首次安装及 UI 启动；不另装 Node。
- [ ] 多屏/负坐标/100%–200% DPI、顶部/侧边任务栏、透明命中、焦点/IME、全屏、休眠、插拔、虚拟桌面、刘海移屏驻留。
- [ ] 退出全部 UI 后系统提醒、通知冷/热启动与自定义目录路由、协议/单实例/后台慢启动。
- [ ] 多运行时互斥和注册失败恢复的真实系统故障注入；已有模型回归不能替代系统故障检查。
- [ ] 四条周期提醒、claim/receipt 失败/超时、系统回退、6 秒收拢、稍后/暂停、休眠补偿，无重复或吞提醒。

### P3：Mac 正式分发与剩余原生迁移

- [x] 共享 Mac Apple Silicon/Intel 预览包的 release 构建、架构、ad-hoc 签名、归档与下载校验通过；仍需外部隔离运行时。
- [ ] 接入真实硬件刘海、安全区、空间/菜单栏、原生玻璃与浮窗完整行为。
- [x] 共享 Mac 正式运行时打包/bootstrap、Developer ID 签名、公证及安装回归：v0.6.0 的 ARM64/Intel 均通过。完整硬件行为另行验收。
- [x] 从旧 UI 模型解耦 EventKit 同步，通过桥接接入新客户端，保留同步关联（2026-10-20：引擎移入 `AppleSyncKit`，通用版 macOS 包内置 `TodoCueAppleSync` 辅助程序，设置新增「同步」标签；沿用 `apple-sync.json` 与原开关；从另一客户端接管的关联在条目被重新找到前，消失只解除关联、不删除任务；旧版运行时暂停同步。见 [Apple 同步](apple-sync.md)）。
- [ ] Apple 同步真机验收：Developer ID 正式包的授权归属与沿用、iPhone 往返、从 v0.5.3 关联接管。
- [ ] 导入语言、尺寸、快捷键与同步偏好；支持 macOS 14+、Intel/Apple Silicon。
- [ ] 保持同一数据目录只有一个生产客户端，提供旧版回退；达到功能和视觉验收后再停止维护 SwiftUI 页面。

## 在新电脑启动和检查

macOS：Node 24+（CI 固定 26.7.0；本地 26.8.2）、Rust、Xcode 26/Swift 6；Windows：Node、Rust、MSVC C++/Windows SDK，ARM64 对应工具链。无需复制本机 `/Users/nanmi` 路径。

已有仓库中先 fetch，再检查继续分支和 worktree；优先复用适合的隔离工作树。下一位接手应使用包含正式共享客户端的最新 main。若同名分支已存在，检查后复用或选择另一个 `codex/` 分支，不重置已有修改。以下命令仅适用于本地分支尚不存在时：

```sh
git fetch origin
git worktree add -b codex/desktop-next ../TodoCue-desktop-next origin/main
cd ../TodoCue-desktop-next
npm ci
TODOCUE_HOME=/tmp/todocue-desktop-next npm run desktop:dev
```

浏览器：`http://127.0.0.1:5173/`；刘海：`http://127.0.0.1:5173/?surface=notch`。默认隔离数据在系统临时目录的 `todocue-desktop-development`，运行时端口 47832。原生预览默认使用相同临时目录；不要改到个人 `~/.todocue`。若并行多个工作树，先设置不同的 `TODOCUE_HOME` 并检查固定端口冲突，不能同时启动默认开发脚本。

已有 `desktop:dev` 时，第二个终端启动原生预览，避免重复启动 Vite：

```sh
TODOCUE_HOME=/tmp/todocue-desktop-next npm run tauri --workspace @todocue/desktop -- dev --config '{"build":{"beforeDevCommand":""}}'
```

仅启动原生开发时，可先用隔离 `TODOCUE_HOME` 启动 `npm run dev:serve`，再启动 `npm run desktop:native`；确保原生进程与运行时使用同一目录。先读桌面 README 再运行，不要把原版生产 App 的退出/启动误当成 Preview 测试。

按改动范围运行：

```sh
npm run check
npm run desktop:check
swift test --package-path apps/macos
```

Windows 包在对应 Windows 主机运行 `npm run windows:preview`。PR #17/#18 的 CI 和合并后手动 Action 已通过；手动触发可重新获取到期产物。安装冒烟脚本只能在可弃用 Windows runner 执行，会安装/卸载预览、登记服务和修改该测试用户的 CLI/PATH；详见桌面 README。本轮仅合并交接分支，预览未提升为正式发布。

## 检查证据与限制

- 前一轮 UI 对照阶段的本地 `npm run check`：175 个 Vitest（25 文件）、24 个脚本测试、CLI/MCP 冒烟、release check 通过；`desktop:check` 前端构建和 Rust 11+5 通过；当时 macOS Preview 与原 SwiftUI 对照 App 构建通过。
- `7ad1b95` 的 [Quality CI](https://github.com/NanmiCoder/TodoCue/actions/runs/38571147359) 全通过：Linux 完整检查、Swift Apple Silicon 275（4 跳过）/Intel 275（11 跳过），均 0 失败。Intel VM 跳过无 GPU 的原生动画检查，截图测试需 opt-in。本地 CLT 缺 XCTest 的限制仍如实保留。
- [Desktop CI](https://github.com/NanmiCoder/TodoCue/actions/runs/38571147367) 全通过：Windows 两种架构实际包/后台七组检查，macOS 前端/Rust 检查。Windows 平台的 Vitest 174 通过/1 跳过、脚本 19 通过/5 跳过；平台专属跳过不与本地计数混淆。
- 周期提醒习惯型计时（追提醒、离开电脑算休息）的自动检查、真实运行时验证与待办的真机清单见 [docs/qa/periodic-habit-timing.md](qa/periodic-habit-timing.md)；空闲时间读取在 macOS 真机与 Windows 上均未验证。
- 实际浏览器/原生证据与截图、布局 JSON 已保存到仓库的两份 QA 记录；没有保存连接 token 或测试数据库。浏览器不替代原生窗口交互，AX 不替代物理鼠标。
- 本机虚拟刘海完整键盘/粘贴/回车与箭头延迟响应输入通过；真实外部鼠标、候选窗口及 Windows GUI 仍需按清单独立验收。Mac Intel Tauri release 预览包已构建并验证归档；正式共享运行时、EventKit 及客户端切换尚未完成。
- 最新 [Quality / 四架构 Desktop / 原 SwiftUI 公证构建](qa/desktop-builds/README.md)全通过：208 项 Vitest、34 项脚本测试，Swift 两架构均 0 失败，Windows 各十组安装检查，以及两种共享 Mac App 下载后的架构/签名/校验和核对。历史计数保留，不与最新计数混淆。

## 接手时的输出要求

先简述当前平台、工作树、首个复现路径，然后持续实施。每个关键修复记录真实触发条件、原因、用户可观察结果和测试边界；更新本文的未完成清单及实现记录。完成一组可验证任务再提交；没有 Windows 硬件时继续可做的代码与构建，但把剩余实机项保留为未完成。

不要以“React 做不到 SwiftUI”替代定位问题，不重写引擎/API/数据库，不隐藏未通过的原生交互，也不要把这份交接快照当作完成四阶段迁移。
