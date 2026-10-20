# Apple 日历 / 提醒事项同步

TodoCue.app 通过 EventKit 把任务镜像到 Apple 的「日历」和「提醒事项」。二者经 iCloud 同步到 iPhone，于是不需要单独的 iOS App 也能在手机上查看和处理任务。只在 macOS 上提供。

同步引擎在 `apps/macos/Sources/AppleSyncKit/`（规划逻辑在 `TodoCueKit/AppleSyncModel.swift`），两个客户端共用：

- **通用版（React + Tauri，正式客户端）**：App 启动时由 Rust 宿主（`apps/desktop/src-tauri/src/apple_sync.rs`）拉起无界面辅助程序 `TodoCue.app/Contents/Helpers/TodoCueAppleSync`（`apps/macos/Sources/TodoCueAppleSync/`）。它自己读 `connection.json`、订阅 `/v1/events`、拉 `/v1/board`，和 SwiftUI 版交给同步引擎的输入完全一样。宿主与它之间是 stdin/stdout 上的 JSON 行：宿主转发设置页的命令（`setEnabled`、`syncNow`、`removeData`、`refreshAccess`、`openPrivacySettings`），辅助程序回报状态，宿主以 `apple-sync:status` 事件推给面板。辅助程序是 App 的子进程，macOS 把日历和提醒事项权限算在 TodoCue.app 名下；App 退出时它的 stdin 关闭，随之退出；意外退出时宿主按 1、2、4…最长 60 秒退避重启。WebView 仍不接触令牌。
- **旧 SwiftUI 版（v0.5.x）**：同一套引擎在 App 进程内运行。

两者都和其他客户端一样，通过现有 HTTP API 读写任务；runtime、API 契约和数据库都没有为此改动。

## 开关与授权

通用版在设置 › 「同步」标签（仅 macOS），旧 SwiftUI 版在设置 › 「Apple 日历与提醒事项」，都是两个独立开关：「同步到日历」和「同步到提醒事项」，默认都关闭。

开关存在 `com.todocue.app` 偏好域的 `appleCalendarSyncEnabled` / `appleRemindersSyncEnabled`，两个客户端读写同一处，所以从 SwiftUI 版换到通用版（或回退）时开关状态保留。隔离的 `TODOCUE_HOME` 使用自己的偏好域（`com.todocue.applesync.<目录摘要>`），测试时开关或「移除同步数据」不会改动真实数据的开关。

**推荐只开「同步到提醒事项」。** 待办在提醒事项里可以直接勾选完成；从 iOS 18 / macOS 15 起，带日期的提醒也会显示在「日历」App 里。两个都开时，同一任务会在日历里出现两次（一个日程、一个提醒），设置里会给出提示。「同步到日历」适合需要时间块排程、与他人共享日程，或设备不显示提醒事项的情况。

- 第一次打开开关时，macOS 会请求「完全访问」权限（请求前会先激活 App，避免弹窗被挡住）。授权按 App 记录：通用版与旧版的 bundle id 都是 `com.todocue.app`，正式签名相同，旧版给过的授权应可沿用。只写权限读不到你在手机上的修改；当前只有写入权限时，再打开开关会重新申请完整访问。
- 如果被拒绝，开关会保持关闭，并显示「打开系统设置」按钮，跳转到 隐私与安全性 › 日历 / 提醒事项。设置页可见时每 2 秒刷新一次授权状态。
- 关闭开关只是停止同步，已同步的条目会留在原处。重新打开后的第一轮，找不到的条目只解除关联、重新创建，**不会**删除任务：关闭期间在手机上清理过条目是正常操作。
- **换客户端时接管已有关联，不会因此删任务。** `apple-sync.json` 记着最近写它的客户端（`client`：`swiftui` / `desktop`；v0.5.3 不认识这个字段，保存时会丢掉它）。记录与当前客户端不同时，每条关联都标记为「接管」（`inherited`），随下一次写入保存，所以 App 重启、某个通道暂时没有权限都不会丢失这个标记。被标记的条目找不到时，照常走 10 分钟宽限和熔断；宽限期满也只解除关联、下一轮重新创建，**不会**删除任务。条目只要被找到一次，标记就清除，之后在手机上删除条目按正常规则删除任务。所以从 v0.5.3 升级到通用版时，期间在手机上删过的条目不会让任务被删，iCloud 短暂读空也不会因此建出重复条目。注意：通用版运行后回退到 v0.5.3，如果 v0.5.3 期间没有任何改动可写，它不会保存文件，`client` 仍是 `desktop`；再升级回来时按同一客户端重启处理。
- **旧版运行时暂停。** 通用版启动时会要求先退出旧 SwiftUI 版，但旧版可能在通用版之后被打开。同步辅助程序每轮检查，发现旧版 TodoCue 正在运行就暂停并在设置里提示，旧版退出后自动继续，避免两个同步引擎同时写 `apple-sync.json`。
- 「移除同步数据」会删除 Apple 侧的「TodoCue」日历或列表，并清空关联。TodoCue 里的任务不受影响。

## 容器

- TodoCue 会在 iCloud 账户里创建名为「TodoCue」的日历和提醒事项列表（要求这台 Mac 上该账户已开启对应的日历或提醒事项）。没有 iCloud 时依次退回默认日历所在账户、本地账户；某个账户拒绝新建日历（如 Google、Exchange）就试下一个。不在 iCloud 时，设置里会提示「不会同步到 iPhone」。
- 打开 iCloud 日历时，macOS 会把「我的 Mac」里的日历并入 iCloud，「TodoCue」日历的标识符不变。同步会跟着记下新的账户，关联保持不变。
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
| 删除任务 | 删除事件 | 删除提醒（任务不存在了，关联随之解除） |
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
| 删除事件或提醒 | 先标记为「缺失」；连续 **10 分钟**以上都找不到，才**永久删除**任务（连同提醒和附件，无法恢复）。已完成的任务只会解除关联，不会被删 |
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
- **熔断**：一轮里要删除的任务超过 `max(3, 关联数 / 5)` 个时，这一轮一个都不删除，关联保留，设置里提示。删除不可恢复，所以这一道比以前的「取消」更要紧。成批「消失」多半是账户或 iCloud 同步的瞬时状态，不是用户在删东西。
- 「TodoCue」日历被整个删掉时，只丢弃旧关联并在同一账户里重新创建，**不会**把所有任务判为已删除然后删除。

## 触发时机

以下事件会触发同步，统一去抖 1 秒（连续触发最多推迟 5 秒）。各轮之间串行执行：去抖只会取消还在等待的那一次，**正在运行的一轮不会被打断**；运行期间到来的触发只会让这一轮结束后再跑一次。

- board 变化（SSE 推送）
- `EKEventStoreChanged`，包括 iCloud 拉到了手机上的修改
- 连接恢复
- 每 5 分钟一次的心跳
- 设置里的「立即同步」

## 已知限制

- 只有 TodoCue.app 在运行时才会同步（通用版由 App 带起辅助程序）。后台 runtime 不访问 EventKit。
- 在手机上改期后，任务的 `reminderAt` 不会跟着移动，Mac 上的通知仍按原来的提醒时间发出。
- 「不设闹钟」只保证 TodoCue 不往条目上加闹钟。iCloud 日历的「默认提醒」会不会被 iPhone 套用到这些事件上，需要在真机上确认。
- 系统授权弹窗里的用途说明目前只有中文。
- 不要在多台 Mac 上同时开启同步，它们会在同一个 iCloud 日历里写出重复条目。
- 本地 ad-hoc 构建（`scripts/build-macos.sh`）每次重签都会改变代码签名。macOS 可能因此要求重新授权日历和提醒事项。
- 签名要求：App 用 `scripts/app.entitlements.plist` 签名，其中包含 `com.apple.security.personal-information.calendars`（开启 hardened runtime 后需要它；hardened runtime 没有单独的提醒事项 entitlement）。通用版的 `Contents/Helpers/TodoCueAppleSync` 也用同一份 entitlements 签名，`scripts/package-macos.mjs` 会检查两者都带着它。Info.plist 需要带上 `NSCalendars*UsageDescription` 和 `NSReminders*UsageDescription`（通用版在 `apps/desktop/src-tauri/Info.plist`）。本地 ad-hoc 构建没有开启 hardened runtime，所以 entitlement 是否正确，只能在 `npm run desktop:macos -- --release` 打出的产物上验证。
- 开发时 `npm run desktop:native` 不带辅助程序，设置页显示「这个构建没有附带 Apple 同步程序」。需要时先 `swift build --package-path apps/macos --product TodoCueAppleSync`，再用 `TODOCUE_APPLE_SYNC_HELPER=apps/macos/.build/debug/TodoCueAppleSync` 指过去；这时授权会算在启动它的终端名下，不能代表正式包。

## 周期提醒不参与同步

喝水、活动等“每天某些时段内每隔 N 分钟提醒”的需求使用独立周期规则。规则和每次投递记录保存在独立表中，不生成任务；TodoCue 日历、Apple 日历和提醒事项均不读取这些规则或记录。设置中的 Apple 同步开关只作用于普通任务及每日/每周重复任务。

这样无需按频率猜测是否同步，也不会为每半小时一次的提醒创建未来 30 天的日程。周期提醒目前由本机 runtime 调度；它不会通过 iCloud 在 iPhone 上发出提醒。
