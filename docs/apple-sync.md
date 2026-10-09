# Apple 日历 / 提醒事项同步

TodoCue.app 通过 EventKit 把任务镜像到 Apple 的「日历」和「提醒事项」。二者经 iCloud 同步到 iPhone，于是不需要单独的 iOS App 也能在手机上查看和处理任务。

同步引擎完全在 TodoCue.app 进程内运行（`apps/macos/Sources/TodoCue/AppleSync/`）。它和其他客户端一样，通过现有 HTTP API 读写任务；runtime、API 契约和数据库都没有为此改动。

## 开关与授权

设置 › 「Apple 日历与提醒事项」里有两个独立开关：「同步到日历」和「同步到提醒事项」，默认都关闭。

- 第一次打开开关时，macOS 会请求「完全访问」权限（请求前会先激活 App，避免弹窗被挡住）。只写权限读不到你在手机上的修改；当前只有写入权限时，再打开开关会重新申请完整访问。
- 如果被拒绝，开关会保持关闭，并显示「打开系统设置」按钮，跳转到 隐私与安全性 › 日历 / 提醒事项。设置页可见时每 2 秒刷新一次授权状态。
- 关闭开关只是停止同步，已同步的条目会留在原处。重新打开后的第一轮，找不到的条目只解除关联、重新创建，**不会**取消任务：关闭期间在手机上清理过条目是正常操作。
- 「移除同步数据」会删除 Apple 侧的「TodoCue」日历或列表，并清空关联。TodoCue 里的任务不受影响。

## 容器

- TodoCue 会在 iCloud 账户里创建名为「TodoCue」的日历和提醒事项列表（要求这台 Mac 上该账户已开启对应的日历或提醒事项）。没有 iCloud 时依次退回默认日历所在账户、本地账户；某个账户拒绝新建日历（如 Google、Exchange）就试下一个。不在 iCloud 时，设置里会提示「不会同步到 iPhone」。
- 首次选定的账户会记下来。之后容器被删掉，只会在**同一个账户**里重建；账户本身不可用（退出 iCloud、关闭 iCloud 日历）时暂停同步并报错，不会悄悄换到别的账户。要换账户，先「移除同步数据」。
- 如果设置了 `TODOCUE_HOME`，且它不是默认的 `~/.todocue`，容器名会带上目录名，例如「TodoCue (tmp.x1y2)」。这样测试用的 runtime 不会认领真实数据的日历，也不会从里面导入任务。
- 关联表保存在 `$TODOCUE_HOME/apple-sync.json`（权限 0600），内容是任务 id 与 EventKit 标识符（`calendarItemIdentifier` 和服务器侧的 `calendarItemExternalIdentifier`）的对应关系，以及上次同步时两边的状态。
- 每个条目的 URL 都设为 `todocue://task/<id>`。日历事件里点击它会打开 TodoCue；「提醒事项」App 不显示这个字段，它在 iCloud 往返后是否保留也没有保证。
- Apple 文档明说 `calendarItemIdentifier` 在完整同步后可能改变。找回关联依次用：标识符 → 服务器标识符 → URL → 与上次快照完全一致的未关联条目。按 URL 或快照找回时，不会把待办任务关联到一条已完成的旧提醒上。

## 映射

| TodoCue | 日历事件 | 提醒事项 |
|---|---|---|
| 范围 | 有日期的 todo 任务 | 有日期的 todo 任务，以及已关联的任务（含从 iPhone 新建的无日期任务） |
| 日期 | 先取计划时间（`scheduledAt`/`scheduledDate`），没有则取截止时间 | 先取截止时间（`dueAt`/`dueDate`），没有则取计划时间 |
| 精确时间 / 只有日期 | 定时事件 / 全天事件 | 带时刻的到期日 / 只有日期的到期日 |
| 时长 | `estimateMinutes`，默认 30 分钟 | — |
| 优先级 | — | 高=1、中=5、低=9 |
| 完成 | 删除事件 | 勾选完成 |
| 取消 / 跳过 | 删除事件 | 删除提醒 |
| 闹钟 | 不设置（提醒由 TodoCue 在 Mac 上发出，避免重复） | 同左 |

重复任务的每个实例都是独立的事件或提醒，不使用 Apple 的重复规则（实例预生成 30 天，所以提醒事项列表里会看到未来 30 天的实例）。Apple 侧带重复规则的条目不会被导入；已同步的条目被改成重复，按「脱离同步」处理。

## 回写（Apple → TodoCue）

| Apple 侧操作 | TodoCue 结果 |
|---|---|
| 改标题、备注 | 更新任务 |
| 拖动或改期 | 写回该条目对应的那组日期字段，并保持 `xxxDate` 与 `xxxAt` 二选一 |
| 改事件时长 | 写回 `estimateMinutes` |
| 改提醒优先级 | 写回 `priority` |
| 勾选提醒 / 取消勾选 | complete / reopen |
| 删除事件或提醒 | 先标记为「缺失」；连续 **10 分钟**以上都找不到，才取消任务（软删除，可在历史中重新打开） |
| 移到别的日历/列表，或改成重复 | 条目还在，只是不再归 TodoCue 管：**脱离同步**，任务保持原样，也不会再建一份 |
| 在「TodoCue」日历或列表里新建 | 创建任务。事件的时间写入计划时间；提醒的到期日也写入计划时间，因为手机上设的日期多半是「哪天做」 |

`completedRetention`：完成超过 30 天的提醒会解除关联。提醒本身留在原处，之后不再处理。

## 冲突与一致性

- 每条关联记着两个基线：上次读回的 Apple 条目（`lastSnapshot`），以及上次希望条目长成的样子（`lastDesired`，由任务映射而来）。规划逻辑是纯函数 `AppleSyncPlanner`，位于 `TodoCueKit/AppleSyncModel.swift`。
- **TodoCue 一侧是否变了，看 `lastDesired`，不看 `version`**：改项目、稍后提醒、拖动排序都会让 version 加一，但条目上看不出区别，不算冲突。
- **按字段三方合并**（`AppleSyncMapper.merged`）：标题、备注、日期、优先级、完成状态各自判断。只有 Apple 改了的字段写回 TodoCue；只有 TodoCue 改了的推给 Apple；**同一字段两边都改了，以 TodoCue 为准**。所以手机上勾选完成、Mac 上同时改了截止日期，两边的修改都会保留。
- 回写之后，只有 TodoCue 自己确实有改动时才推送。Apple 侧对数据的规范化（去掉 URL、改优先级档位）、多日全天事件这类映射表达不了的形状，都会原样保留，不会被反复改回去。
- 回写失败的处理：
  - runtime 拒绝某个值（4xx）：该字段以 TodoCue 为准写回条目，并在设置里显示错误；完成状态的变化仍然照常处理。
  - `VERSION_CONFLICT`：3 秒后再跑一轮。
  - 回写分多步（改字段 + 完成）时，每一步成功都会立即记录，中途中断不会被误判成 TodoCue 自己的修改。
- 如果 board 里的任务版本比上次同步记录的还旧，说明是同步自己写入之前的快照。这种情况直接跳过，避免把旧值推回 Apple。
- 从 Apple 导入任务时，幂等键由条目标识符和内容算出。请求已经落地、响应却丢了时，下一轮重放同一请求，不会建出第二个任务。
- 删除条目时先删关联、再删条目；中途崩溃只会留下一个无主条目，不会被当成「用户删除了」。
- **熔断**：一轮里要取消的任务超过 `max(3, 关联数 / 5)` 个时，这一轮一个都不取消，关联保留，设置里提示。成批「消失」多半是账户或 iCloud 同步的瞬时状态，不是用户在删东西。
- 「TodoCue」日历被整个删掉时，只丢弃旧关联并在同一账户里重新创建，**不会**把所有任务判为已删除然后取消。

## 触发时机

以下事件会触发同步，统一去抖 1 秒（连续触发最多推迟 5 秒）。各轮之间串行执行：去抖只会取消还在等待的那一次，**正在运行的一轮不会被打断**；运行期间到来的触发只会让这一轮结束后再跑一次。

- board 变化（SSE 推送）
- `EKEventStoreChanged`，包括 iCloud 拉到了手机上的修改
- 连接恢复
- 每 5 分钟一次的心跳
- 设置里的「立即同步」

## 已知限制

- 只有 TodoCue.app 在运行时才会同步。后台 runtime 不访问 EventKit。
- 在手机上改期后，任务的 `reminderAt` 不会跟着移动，Mac 上的通知仍按原来的提醒时间发出。
- 「不设闹钟」只保证 TodoCue 不往条目上加闹钟。iCloud 日历的「默认提醒」会不会被 iPhone 套用到这些事件上，需要在真机上确认。
- 系统授权弹窗里的用途说明目前只有中文。
- 不要在多台 Mac 上同时开启同步，它们会在同一个 iCloud 日历里写出重复条目。
- 本地 ad-hoc 构建（`scripts/build-macos.sh`）每次重签都会改变代码签名。macOS 可能因此要求重新授权日历和提醒事项。
- 签名要求：App 用 `scripts/app.entitlements.plist` 签名，其中包含 `com.apple.security.personal-information.calendars`（开启 hardened runtime 后需要它；hardened runtime 没有单独的提醒事项 entitlement）。Info.plist 需要带上 `NSCalendars*UsageDescription` 和 `NSReminders*UsageDescription`。本地 ad-hoc 构建没有开启 hardened runtime，所以 entitlement 是否正确，只能在 `npm run macos:dmg` 打出的产物上验证。
