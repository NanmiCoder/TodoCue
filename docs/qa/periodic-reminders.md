# 周期提醒验收记录

2026-10-11。新增独立周期规则、轻量创建/管理界面、刘海优先投递，以及 CLI/MCP/Skill 的一句话创建路径。

## 自动检查

- `npm run check:macos` 通过：TypeScript 构建、118 项 Vitest、发布脚本测试、真实 CLI/MCP 冒烟、发布一致性，以及 246 项 Swift 测试（3 项 opt-in 截图测试在全量检查中跳过）。
- `TODOCUE_PERIODIC_SHOTS="$PWD/docs/qa/evidence/periodic-reminders" swift test --package-path apps/macos --filter PeriodicReminderTests`：修复后 9 项全部通过，单独执行了周期截图测试。
- `uv run --with pyyaml python <skill-creator>/scripts/quick_validate.py skills/todocue` 通过。
- `git diff --check` 通过。

回归场景包括共享默认值、周末/多个时段、结束边界、全天 24:00、两种计时、完成重放、延后轮次和合并、午休等待、隔天重置、旧卡片/版本冲突、暂停/删除、休眠重启、抢占与系统降级、通知拒绝、异步投递时删除、各规则独立时区和 DST。修复回归另外覆盖旧缓存与列表响应乱序、迟到保存保留新草稿及其再次提交、跨午夜延后和已持久化旧延后的恢复、异步投递越过结束边界，以及滚动计时的 DST gap/fold。既有任务、附件、排序、日历及 Apple 同步测试保持通过。

真实 CLI/MCP 冒烟启动一次性持久化 runtime 和独立 MCP 进程，完成最小参数创建、明确星期创建、同键重试、跨入口查询、版本化编辑、今天暂停及重启恢复。周期规则创建前后，任务数量保持一致；JSON 导出包含周期数据。

## 原生界面与投递

通过真实 App 的 UI 自动化，在隔离 `TODOCUE_HOME` 中验证：

1. 从主面板菜单进入新建周期提醒。
2. 喝水模板只改标题；打开星期选择，选周末。
3. 默认间隔与时段明确显示，“更多设置”默认收起，下一次时间随配置变化。
4. 一次点击创建，返回管理页，显示新规则和撤销入口。
5. “今天暂停”立即更新状态；另一条完成后计时规则在管理页点击“完成本次”后重新计时。

隔离 runtime 与真实 App 之间的刘海抢占和展示回执记录为 `displayed`。原生 XCTest 另行创建真实 `NotchWindow`，验证实际卡片出现、窗口宽度 460pt、不能成为键盘窗口，并保存其窗口内容。投递回执与用户完成分别记录，卡片收起不会完成规则。

测试 App 和临时 runtime 已停止。图片使用固定 API fixture 或专用原生测试窗口；不代表用户个人任务。

## 图片

- [中文 300pt 创建卡片](evidence/periodic-reminders/zh-Hans-300-create.png)
- [中文 480pt 创建卡片](evidence/periodic-reminders/zh-Hans-480-create.png)
- [中文 300pt 管理页](evidence/periodic-reminders/zh-Hans-300-manage.png)
- [英文 300pt 创建卡片](evidence/periodic-reminders/en-300-create.png)
- [英文 300pt 管理页](evidence/periodic-reminders/en-300-manage.png)
- [真实原生刘海窗口内容](evidence/periodic-reminders/native-notch.png)

另有 480pt 的中英文管理/创建图片，共 9 张。

## 尚需硬件与系统环境验证

当前机器仅连接内置 Retina 刘海屏（1728×1117，顶部安全区域 32pt）。外接屏负坐标、虚拟刘海几何和全屏判断有自动测试覆盖；以下实机验收尚未完成：

- 外接显示器上接收周期卡片、跨屏移动鼠标、关闭虚拟刘海时降级。
- 展示期间拔插显示器与切换全屏空间。
- 在已授权的实际通知中心中点击周期通知的完成/延后按钮。当前验证为 helper 编译、投递参数、runtime 通道竞争、模拟通知拒绝及 API 行为，不等同于通知中心实机验收。

实现的已知投递边界：App 抢占后、回执前崩溃可能丢失本次提醒，记录失败并安排下一轮，不补发第二通道。周期提醒只在本机运行，不通过 Apple 日历或提醒事项向手机推送。
