# 日历视图验收记录

2026-09-08。功能：面板内独立的日历页，按月／周查看过去、当前与未来任务。

## 范围

- 头部日历图标（⌘⇧K）进入独立 Route，不占用「今日／即将到来／全部」三段控件。
- 月视图：格子只画状态标记，选中某天后由下方日程区展示完整任务行（「日」折叠于此）。
- 周视图：7 个日区块，含过去的天与已完成任务。
- 30 天预生成范围之外的重复任务，前端按 `Series.rule` 推算只读「待生成」占位。后端与 `docs/api.md` 零改动。

## 自动门禁

- `npm run check`：TypeScript 构建、单元测试、发布脚本测试、CLI/MCP 冒烟、版本一致性——通过。
- `swift test --package-path apps/macos`：140 项，其中 2 项 opt-in 截图测试跳过，其余全部通过。
- `git diff --check` 通过。

## 渲染证据

`node scripts/calendar-screenshots.mjs docs/design/evidence/2026-09-08-calendar` ——
离屏 `ImageRenderer` 渲染，中英 × 明暗 × 300/340pt，明细见该目录 README。
不开窗口、不抢焦点，数据库为一次性临时 `TODOCUE_HOME`。

## 对抗性审查修掉的问题

两轮独立审查（正确性 / UI 与规范）后修正：

| 严重度 | 问题 | 处理 |
|---|---|---|
| 高 | `SeriesProjection` 以日期字符串做游标，遇到 regex 合法但不存在的日期（如 `2026-02-30`，运行时只做正则校验且 `createSeries` 不调 `assertDate`）会永不前进，挂死主线程 | 改为整数儒略日迭代，日期解析失败则跳过该 series；补 `testAMalformedButStorableDateSkipsTheSeriesInsteadOfHangingTheMainActor` |
| 高 | 实时更新以 `routes.last == .calendar` 为闸门，从日程行打开任务详情后日历即冻结，返回后带着过期 `expectedVersion` 提交会 409 | 改为 `routes.contains(.calendar)`；补路由闸门测试 |
| 高 | 月视图格子内容 26–28pt 而 `minCell` 只有 22pt，网格不裁剪 → 行间重叠 | `minCell` 绑定到 `cellContent`，补遍历全部可达高度的属性测试 |
| 高 | `apply(board)` 每次 SSE 都无条件作废历史缓存，四个月窗口反复重拉且互相取消，事件密集时历史永远拉不回来 | 改为按待办 id 集合变化判断；选中某天不再触发重建或请求 |
| 高 | 首版证据里 `showCalendar()` 不重置跨度，所有月视图截图实为周视图 | 重置跨度 + 快照测试断言跨度与输出互不相同 |
| 中高 | 已完成任务的截止日仍被计入待办、画红条、给出可勾选行 | `deadlines` 只收 `status == .todo`；`openCount` 不再计入截止（否则一周表头合计超过实际工作量） |
| 中 | 周视图与日程区标题不含年份，翻到 2027 年 3 月与 2026 年 3 月字面相同 | 新增 `CalendarRange.dayLabel`，跨年自动带年；周标题同理 |
| 中 | 月份翻页把选中日挪到首个同星期几的日子，来回翻不回原处 | 月步进保持日期序号，周步进保持星期几 |
| 中 | `.runtimeStarted`（连接文件重写、运行时重启）也把用户拽回今天 | 只有 `.dayChanged` 且原本停在今天才回today |
| 中 | 已完成列表取自 `Dictionary.values`，顺序不定且会随写入重排 | 按完成时间倒序排序 |
| 中 | 英文 `"{0} 件"` 渲染成 "1 items"；中文「上一月／下一月」不地道；VoiceOver 文案出现「运行时」这种开发者词汇 | 重写 27 条词条 |
| 中 | 跨度切换控件是 `TabBarView` 的复制粘贴 | 抽出共用 `SegmentedCapsule`，两处共用；补 `today-tabs` 截图守住既有外观 |
| 中 | `historyTasks` 只增不删，翻一年会把全年已完成任务留在内存 | 每次拉取只保留当前窗口 |
| 中低 | 离线时空日与「加载失败」不可区分 | 新增 `calendarHistoryFailed`，空态区分文案 |
| 中低 | 日程区空态用整页 `EmptyStateView`（约 180pt），而该区最矮 120pt | 改为一行文字 |
| 中低 | ⌘⇧K 挂在根路由的按钮上，进入任何子页面即失效 | 移到 `AppDelegate` 的全局键盘监听，与 ⌘N/⌘F/⌘R/⌘, 一致 |
| 低 | 「截止」分区标题恒为红色，即使并未逾期 | 仅在确有逾期时用 `Theme.overdue` |
| 低 | 「回到今天」是无悬停反馈的纯文字按钮 | 加入与其他控件一致的悬停底色 |
| 低 | 三个测试是同义反复（未使用的变量、拿函数和自己比较、断言空模型返回空） | 全部重写为有判别力的断言 |

## 第二轮：拖拽改期与按天新建

日历上改期不该要求点进详情，拖拽才是这个界面的动词。首版把它排除掉的理由（拖放区域表按
`(window, PanelTab)` 索引，复用会污染「即将到来」）**是错的**：`PanelRootView` 只渲染
`routes.last`，日历作为 Route 显示时列表根本没挂载，两者的 region 不可能同时存在。

### 为什么不走 `moveTask`

服务端 `moveTask` 的 upcoming 路径有两条硬限制（`engine.ts:636`、`:646`）：源任务的
`listGroup` 必须非空——而它只在 `planDate > today` 时返回日期；目标日期必须 `> today`。
于是「把逾期的拖到今天」「把明天的拖回今天」都会被拒。它还会把一次普通改期卷进
`list_ordering` 的 revision 事务。

日历的拖拽语义是**改期**而非排序，所以直接 PATCH 计划日期：保留 `scheduledAt` 的时刻，
截止与提醒原样不动（与列表跨日期拖拽的既有文案一致），落在截止之后时弹出与列表相同的确认框，
成功后 toast 提供撤销。纯函数 `TaskRescheduling.plan` / `landsAfterDeadline` 有单测覆盖。

### 类型：`DragSurface`

`TaskDrag` / `TaskDropTarget` / `TaskDragSlot` 原本以 `PanelTab` 做命名空间，而
`PanelTab.rawValue` 会作为 `MoveTaskInput.view` 上行并被 `z.enum(["all","today","upcoming"])`
校验。给它加 `.calendar` 会让非法值可达；借用 `.upcoming` 则把正确性押在「两个界面永不同时挂载」
这个隐式不变量上。因此抽出 `enum DragSurface { case list(PanelTab), calendar }`，
只有 `.list` 能拿到上行的 `tab`。既有 11 项拖拽测试改标签后全部通过，行为未变。

### 其他

- 日历行用 `reorderable: false`：它们参与测量与提起，但不是落点，落点只有「天」。日内重排没有意义，
  而且真去做就会撞上上面那两条服务端限制。
- 拖放区域只在拖拽进行中挂载。否则一个月视图会常驻 42 个 AppKit 视图，且离屏渲染完全画不出内容。
- 周视图现在恒显 7 天（空的那天只留标题行）——会自动隐藏空日的周视图，恰好把最有空的那几天变成拖不过去的。
- 底部常驻 quick-add，绑定当前选中日（「添加到 9月11日…」），「添加详情」升级到表单时日期已预填。
  代价：日历页固定少 57pt，因此 360pt 最矮面板下六周月份连强制展开都放不下（`canExpand` 会拒绝而不是裁剪）。
- 英文计数改回裸数字：本地化目录没有复数规则，`"{0} tasks"` 在 1 的时候会读成 "1 tasks"。

## 已知边界

- 不能拖拽**已完成**的任务（`canDrag` 要求 `status == .todo`），也不能拖拽「截止」分区里的行——
  那些任务计划在别的日子，拖动只会改计划而不改截止，容易误解。
- 一次历史拉取受 `limit` 上限 1000 约束，因此不提供「年」跨度。
- 无键盘方向键导航：面板内所有列表控件都没有，日历不做例外；但全键盘访问下月视图会多出 42 个 Tab 停靠点。
- 未真机验证：**真实鼠标拖拽的完整手势链路**、拖拽改变面板尺寸时的重排、SSE 实时变化、离线降级、VoiceOver 实际朗读。
