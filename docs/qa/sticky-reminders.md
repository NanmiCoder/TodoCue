# 提醒常驻与堆叠验收记录

2026-10-12。设计与取舍见 [sticky-cue.md](../design/sticky-cue.md)。

## 自动检查

- `swift test --package-path apps/macos`：275 项，0 失败，4 项 opt-in 截图测试跳过。
- 新增：`CueStackTests`（排序与到达顺序、同规则合并与计数、重放与过期、容量与优先淘汰、时段内外、行键、何时算「仍在等待」）；`PeriodicActivityTests`（半开时段、周一为 1 与周日为 7、休息与 24:00、其他时区与停用、已等分钟）；`NotchStackControllerTests`（真实刘海窗口）。
- 真实控制器覆盖：从运行时的未回应状态恢复；整卡退为一行后仍留着；第二条加入堆叠而不是被拒绝；同一规则再次触发合并为 ×2，别处完成后移除；× 收进翼标但不丢，新到达后展开；回应在途时行保留、被拒绝时留下并报错、成功后才离开；切换 Space 或打开面板不收起。
- 原有 `testRealNotchClaimsDisplaysAndDoesNotTakeKeyboard` 通过：认领、展示、回执、窗口宽度 460、不抢键盘。

## 基线说明

该原有测试在开始时即失败：当前机器前台应用是全屏窗口，刘海的全屏判断（默认开启）使它拒绝认领，与本次改动无关。现在测试在运行期间把「全屏时不显示」设为关闭并恢复，使其不依赖机器当时的前台应用。新增的控制器测试同样如此。

## 图片

由 `TODOCUE_STACK_SHOTS=<目录> swift test --filter NotchStackControllerTests/testRenderStackStates` 生成，用真实 `NotchRootView` 和固定夹具渲染，中英文各 7 张。不代表用户个人任务。

- [中文：单条 · 刚落下](evidence/sticky-reminders/zh-Hans-1-featured.png)　[单条 · 常驻一行](evidence/sticky-reminders/zh-Hans-1-rest.png)
- [中文：三条 · 刚到达](evidence/sticky-reminders/zh-Hans-3-arrival.png)　[三条 · 常驻](evidence/sticky-reminders/zh-Hans-3-rest.png)　[三条 · ×3](evidence/sticky-reminders/zh-Hans-3-repeat.png)
- [中文：五条 · 折叠](evidence/sticky-reminders/zh-Hans-5-fold.png)　[翼标计数](evidence/sticky-reminders/zh-Hans-wings.png)
- 英文同名文件以 `en-` 开头。

## 尚需实机验证

以下依赖真实显示器、前台应用和时间流逝，自动测试没有覆盖，未验证，不应视为通过：

- 内置刘海屏上的整卡到一行的过渡动画观感，以及整卡/一行高度变化时窗口跟随是否平顺。
- 外接显示器：新提醒落在指针所在屏、指针停留 1.5 秒后堆叠迁移、跨屏经过时不闪动。
- 全屏应用前台时只剩翼标，退出全屏后恢复；屏幕插拔与切换全屏空间期间的堆叠。
- 经过约 5 分钟后翼标的波纹；跨过午休和当天最后一个时段结束时行的退场与再次落下（逻辑由 `CueStack` 与 `isActive` 测试覆盖，但时间流逝本身未在真机观察）。
- 在已授权的通知中心里点击周期通知的完成/延后：与此前一致，仍未实机验收。
