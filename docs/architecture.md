# 微信 USB 插件 · 当前全流程（触发条件 → 执行动作）

> 版本：**2026-11-15**，代码 `f957281`（2.0.0-dev，多会话）
> 适用：`autoReply.enabled = true` 时的轮询器（`lib/poller.js`）+ 工具层（`index.js` / `lib/core.js`）+ 唤醒会话
> 单窗口（`multi.enabled = false`）保留 v0.3.1 行为，差异见 §16；单窗口细节另见 [`single-window-design.md`](single-window-design.md)
> 配套大图：[`full-flow.png`](full-flow.png)（一页看完整条链路）；历史版本：`git show 842718d:docs/architecture.md`

本文只描述**现在真实在跑的逻辑**，每个条件都能在代码里对上。参数默认值与笔记本现网值见 §13。

---

## 1. 一句话

**平时停在聊天列表，用「未读红点 + 预览变化」发现有会话在说话；进去以后靠「聊天区差分 + @ 时间线 + 讨论串」判断这一屏要不要接；要接就通过 `schedule` 唤醒 DSH 会话，由她调 `wechat_send` 发出去；发完继续钉在这个讨论串里，串散了才回列表。**

硬约束（设计上不可违背）：

1. **单窗口**：手机同一时刻只有一个前台会话，切走 = 上下文丢失；所以只有一条活跃讨论串、一次只处理一个会话。
2. **读屏是唯一输入**：没有消息 API，全靠 adb 截图 + 识别；识别有抖动，所以所有判定都要能容忍读歪。
3. **群聊不主动开口**：群里没 @、又没有活着的串 → 一律只看不回；「主动搭话」是另一条独立通道（§10）。
4. **发送必须核对目标会话**：唤醒时的会话和发送时的屏幕可能已经不是同一个。

---

## 2. 组件与数据流

```
┌──────────────┐  ADB(USB)   ┌──────────────────────────────────────┐
│ Android 手机  │◄───────────►│ dsh-wechat-usb 插件                   │
│ 微信 8.0.80  │ 截图/点击/输入│  lib/poller.js   轮询器/状态机/串/唤醒   │
└──────────────┘             │  lib/core.js     ADB、守卫、限频、发送   │
                              │  lib/rotation.js 会话轮换              │
                              │  lib/api.js      127.0.0.1:65470 状态 API│
                              └──────────────┬───────────────────────┘
                                             │ schedule.create（一次性，800ms 后）
                                             ▼
                              ┌──────────────────────────────────────┐
                              │ DSH 唤醒会话（autoReply.wakeSessionId）│
                              │ 读 prompt → 决定回不回 → wechat_send   │
                              └──────────────┬───────────────────────┘
                                             │ wechat_send(text, chat)
                                             ▼
                                       手机上的微信窗口
```

三条边：

- **看**：`adb screencap` → 本地识别（rapidocr / windows / qwen-vl / ds-vision）→ 文本行 + 坐标；
- **想**：新消息 + 会话名 + 串上下文 + 规则 → prompt → `schedule` 投给唤醒会话；
- **做**：模型调 `wechat_send`，插件核对目标会话、过安全守卫与限频、点发送、写 `last-send.json`。

---

## 3. 模式与状态机

两个正交的开关：

| 开关 | 取值 | 含义 |
|---|---|---|
| `autoReply.enabled` | false / true | 轮询器是否在跑（设置页「自动回复」） |
| `multi.enabled` | true（默认）/ false | 多会话巡场 / 单窗口死盯 |

轮询器内部只有一个状态 `state.mode`：

```
                 ┌──────────────────────── IDLE（巡场）────────────────────────┐
                 │ 每 listScanSec(15s) 一次 idleTick：                          │
                 │ 锁屏? → 回列表 → 扫列表 → 准入 → 选候选 → 进入 → capture       │
                 └───────────────┬─────────────────────────────────────────────┘
                                 │ 进了某个会话
                                 ▼
                 ┌──────────────── THREAD（钉住）──────────────────────────────┐
                 │ 每 tick：capture（不扫列表、不快轮）                          │
                 │ 串活着 或 叫醒后 90s hold 内 → 留下                           │
                 │ 串散了 / 发完了 → 回 IDLE，并给该会话 perChatCooldownSec 冷却  │
                 └─────────────────────────────────────────────────────────────┘
```

单窗口模式没有 `idle`：每轮直接 `capture()`，对 `whitelistChats[0]` 死盯。

---

## 4. 定时器与每轮入口

| 定时器 | 间隔 | 何时跑 | 做什么 |
|---|---|---|---|
| 慢轮 `intervalSec` | 默认 15s（笔记本 30s） | 两种模式 | 兜底 `fullTick()`；距上次完整一轮 < 1.5s 则跳过 |
| 快轮 `probeSec` | 默认 4s | 两种模式；多会话**只在 thread 态**跑 | 只读 `dumpsys gfxinfo` 的累计帧数（~140ms），变了才 `fullTick()`；连续 3 次读不到 → `probeBroken`，自动退回单轮询 |
| 列表轮 `listScanSec` | 默认 15s | 仅多会话 idle 态 | `idleTick()`；thread 态自动跳过 |
| 轮换检查 | 5 分钟 | `rotation.enabled` | 见 §10.4 |

`fullTick()` 固定顺序：

```
fullTick(cfg)
 ├─ 0. owner 守卫：热重载后旧实例的定时器即使还在，也不许再动
 ├─ 1. flushMentionBacklog()   inbox 里挂着的 @，冷却一过就补发（§10.2）
 ├─ 2. flushPending()          冷却/归并期间攒下的消息，到点一起回（§10.3）
 ├─ 3. 分派：
 │      multi.enabled ?
 │        mode==="thread" ? （串活着 或 还在 90s hold 内 → capture；否则回 idle + idleTick）
 │        : idleTick()
 │      : capture()            // 单窗口
 └─ 4. 每 20 轮清理一次旧截图（最多留 300 张）
```

---

## 5. 巡场：从列表到进入会话（多会话 `idleTick`）

### 5.1 触发条件

`idleTick()` 被调用（列表轮/慢轮/串结束回到 idle）后，**依次**过这些闸，任何一条不满足就结束本轮：

| # | 检查 | 不满足时 |
|---|---|---|
| 1 | `multi.enabled` | 直接返回 |
| 2 | 手机亮屏（`dumpsys power` 的 `mWakefulness=Awake/Dreaming`） | 记一条 `phone-locked`（10 分钟最多一次），返回；**不重启微信** |
| 3 | `state.busy` 未占用 | 返回 |
| 4 | 距上次扫列表 ≥ `listScanSec - 0.8s` | 返回 |

### 5.2 回列表 `ensureChatList()`（最多 5 轮）

判定页面用**像素探针** `page_probe.py`（约 30ms：白底比例 + 底部四簇 tab + 返回箭头 → `list / chat / search / other`），探针失败才回退 OCR。

| 当前页 | 动作 |
|---|---|
| `list` | 成功，把这张截图交回去复用 |
| 不在微信（`other`） | `am start -n com.tencent.mm/.ui.LauncherUI`，等 800ms |
| 搜索页（焦点含 `FTS/Search`） | `back` → 500ms → `back` → 500ms → `am start`（这一页一次 back 回不去，am start 也会被吞） |
| 会话页（`chat`） | `am start`（幂等，不会把微信退出去）→ 再探针；还不是列表才 `back` |
| 5 轮仍失败，且连续 3 次 | 判定微信僵死（dumpsys 说前台、截图是桌面）：`am force-stop` → 1.5s → `monkey` 拉起 → 等 6s |

> ⚠ 这里踩过两次坑：用 `focusIs("LauncherUI")` 判列表会误判（会话页也报 LauncherUI）→ 点搜索点到聊天页、把人带出微信；用 `focusIs(ChattingUI)` 判进入永远 false → 搜进去又自己 BACK 退出来。**现在只信像素探针 + 标题核对。**

### 5.3 扫列表 `scanChatList()`

1. 复用 5.2 的截图（没有才重拍）；
2. 校验顶部确实是「微信」（OCR `scale=3` 裁 80~180）；
3 用 **Windows OCR** 读 `x≥190, y≥120`（跳过头像和红点），`parseListRows()` 按 110px 聚成会话行：
   - 名字：左侧（x<700）、非纯数字、非时间；
   - 预览：左侧另一行；
   - 群/私聊：名字带 `(N)` 或预览带「昵称：」→ 群；
4. **未读用像素数**：`badge_probe.py` 只数每行头像右上角一小块红色像素，`>40` 记为未读 1（Windows OCR 读不出红底白字，实测整列为空）；
5. **群/私聊以记忆为准**：列表行的类型只是猜的（名字带 `(N)` 或预览带「昵称：」才算群）——她自己最后发言、或最后一条是图片/链接时，预览没有昵称前缀，会被猜成私聊。
   所以 `scanChatList()` 解析完先查 `data/chats.json` 的记忆覆盖，再 `markChatKind()`；
   后面进会话时标题没读到 `(N)` 也不会把已知的群降级成私聊。
6. 写 `data/chat-list.json`、`data/scan.log`。

### 5.4 采纳「她自己开的串」`adoptSelfThread()`

如果最近 15 分钟内她发过的话，出现在列表某个会话的预览里，而那个会话没有活串 → 立刻开一条 `trigger=self` 的串。
（她自己 `wechat_open` 过去搭话，轮询器当时不在那个会话里，不补这一步，后面别人接话就没人认。）

### 5.5 准入与候选

- **准入** `filterAllowed()`：私聊**全部放行**；群聊必须命中 `whitelistChats`（空名单 = 不限）。
- **候选** `chooseCandidate()`：一行要同时满足
  1. `unread > 0`；
  2. **预览文字变了**（`lastPreview` 按会话记归一化预览；首次见到也算变；一直挂着未读但预览没变 → 不重复进）；
  3. 不在该会话的 `perChatCooldown` 里；
  4. 排序：`有人@我/提到我` 的预览 > 私聊 > 群聊，同优先级按未读数。

**没有候选** → 走主动搭话判断（§10.1）；有候选 → 进入会话。

### 5.6 进入会话

主路径是**搜索进入**（`multi.enterBySearch !== false`，位置无关，不怕列表在截图→点击之间重排）：

```
openChat(name 前 10 字)：
  toHome()（探针判页，见 5.2）
  → 点右上搜索 → 点搜索框 → ADBKeyboard 输入
  → 先连按 25 次退格清空上次残留（否则查询串会拼成垃圾、第一条变「搜一搜」→ webview 死循环）
  → 点第一条结果
→ 读标题（顶部 55~205 带，OCR scale=3）→ sameChatName 核对
```

标题核对用**最长公共子串**（去标点后：短名要 4 字、长名要 8 字），因为列表里的名字会被省略号截断、标题里带 `(23)`、OCR 还会在前面粘噪声。
核对不过 → `back` 回列表，改走**点行兜底**：点这一行的中心 → 等 `enterSettleMs`(500ms) → `readChatTitle()` 再核对。

| 情况 | 动作 |
|---|---|
| 标题 ≠ 点的行（列表重排） | `back`，记 `enter.log`；**不冷却**，立刻重扫重试一次；连续 2 次才冷却 `perChatCooldownSec` |
| 标题是群、且群不在白名单 | `back`，冷却 `max(600s, perChatCooldownSec)` |
| 标题带 `(N)` | 确定为群，`markChatKind(group)`（标题的成员数是最硬线索） |
| 通过 | 继续 |

### 5.7 进会话后

1. **私聊**：立刻 `openThread(dm)`（一对一没有「群里看一眼」的问题，进来就是一条串；闲置 TTL 用 `dmThreadTtlMin`=5 分钟）；
2. **带未读**：先滑到底（3 次 swipe，微信会停在第一条未读、最新消息在下面）；
3. **未读 ≥ 4**：`findMentionTag()` 先在顶部找「有人@我」标签；**有**就点它 → `waitScrollSettle()`（每 400ms 截帧，连续 2 帧哈希一致才算停，上限 5s；期间探针静默）；**没有**就直接看当前这一屏（未读不够多时微信不显示这个标签）；
4. 设 `current / mode=thread / justEntered=true`（**第一屏全部算新**，交给后面的 seen 去重）；
5. 调 `capture()`：屏幕没被动过时复用刚才读标题那张截图，不再重拍。

### 5.8 这一轮「叫没叫醒」决定去留

- `capture()` 里真的唤醒了（`lastWake.at ≥ enterAt`）→ 记 `chatHoldUntil = now + 90s`，**屏幕别动**，等她写完发出去（或超时）再回列表；
- 没叫醒 → 如果这个会话没有活串，就 `mode=idle`、回列表、给该会话 `perChatCooldownSec` 冷却。

---

## 6. 读屏判定（`capture`）

### 6.1 前置

| 检查 | 动作 |
|---|---|
| 焦点不含 `com.tencent.mm` | 本轮结束 |
| 正在等「@ 跳转」的滚动动画（`scrollSettling`） | 本轮结束（会截到中间帧） |
| **单窗口**：前台不在 `whitelistChats[0]` | `tryAutoOpen()`：回列表→搜索→点第一条；失败退避 60s，连续 2 次失败退避 5 分钟 |
| 每次真采一帧前 | `settleLastWake()`：结算上一次唤醒有没有换来发送（§7.2） |

### 6.2 采样与动图

1. 截图（约 0.65s）+ 区域哈希；
2. 和上一帧比：**没变化 → 直接结束，连 OCR 都不跑**；
3. 变了才做像素差分 `frame_diff.py`（下采样到 270 宽、逐行平均差）：变化带够窄（≤35%）+ 中心没挪窝（≤12%）→ 判定「同一处还在动」（动图 / 表情 / 加载），这一帧的图片描述**不算新消息**；
4. 识别模式由 `cfg.mode` / `ocr.engine` 决定：
   - `text`（默认）：识别成文本行，走差分；
   - `frame`（`mode:"frame"` 或 `engine:"ds-vision"`）：不做本地识别，整帧存 inbox，**变了**就按 `intervalOk()` 决定叫不叫醒（`wakeOnImage!==false`）。

### 6.3 识别引擎（设置页三选一，`ocr.engine`）

| 引擎 | 行为 | 失败时 |
|---|---|---|
| `rapidocr`（默认） | 传统 OCR，逐行文本 + 坐标；快、省 | 退回 Windows OCR |
| `windows` | 同传统 OCR，改用 Windows 自带识别；兜底用 | 退回 rapidocr |
| `qwen-vl` | 本地 4B（默认 `qwen3-vl:4b-instruct`，走 Ollama），读成「昵称：内容」；能读表情/图片、能分说话人、能顺带判整屏值不值得；1~2s/帧 | 自动退回 rapidocr，`/poll` 的 `fallback` 能看到原因 |
| `ds-vision` | 本地不识别，整帧交给唤醒会话自己 `read_image` | — |

多会话模式下 OCR 从 **y=180** 起裁（顶部通知横幅根本不进识别区），标题以「我们点进来的那个会话」为准，不采信 OCR 猜的标题；单窗口保持标题带一起读。

### 6.4 归一、差分、去重

- **归一 `lineKey()`**：剥掉 OCR 拼进来的「昵称：」前缀；把「谁：图片：…」整行压成「谁：〔图片〕」；纯图片描述压成 `〔图片〕`。这样同一张图换一帧描述不会算新消息。
- **噪声** `isUiNoise()`：`微信：刚刚`、`有人@我`、`[16条]`、`12:22` 这类浮层/提示行，差分前丢掉。
- **差分** `diffNewText()`：只留这一帧新增的行。
- **去重四层**（`classifyFresh`）：
  1. 结构性：VL 给她的绿气泡统一标「我：」→ 直接排除；
  2. 内容性：最近 15 分钟自己发过的内容，完全相等 / 包含 / 字符二元组 Jaccard≥0.5 都算自己；
  3. 精确：`seen` 里 30 分钟内出现过的行不再算新（滚动/重绘/识别抖动）；
  4. **时间优先**：我们在这个会话发言那一刻屏幕上已有的行（`preSend`），20 分钟内不再算新——内容比对会被 OCR 读歪，但「比我们的话还早」是硬事实。
- 一屏只剩图片描述、又没人 @ → 先让 4B 看前后两帧（`judge_frames.py`）裁决「画面里到底有没有新消息」；说没有就不叫醒。

### 6.5 @ 判定（按时间，不按位置）

`detectMention()` 在**整屏**找命中 `mentionKeywords` 的行，但只有**新的**才算：

- 排除「我：…」、「@某人：…」（引用头/回显，不是真 @）；
- 这一行在 `seen` 里的首次出现时间，必须**晚于**该会话上一次「她发言」和上一次「因 @ 唤醒」；
- 命中 → 开/续一条 `mention` 串，必回。

> 以前只在 `kept` 的 y 范围附近找 @，@ 在最后一行、kept 却是别的行时会漏（某个群就是这么漏的）；现在只看时间，不看范围。

### 6.6 讨论串状态（见 §9）

`threadState()` 给这一轮定性：

- **mention**：有人 @ → 开新串 / 续旧串，**必回**；
- **thread**：没 @ 但串活着：
  - 私聊：对方每条都算「对着她说」，续命；
  - 群聊：只有 @ / 引用回复她 / **她 3 分钟内真的说过话**才算续命；
  - 群里别人的闲聊：**不续命、不叫醒**；
- **idle**：没 @ 也没串。

### 6.7 多会话的硬闸

**群里既没 @、也不是私聊、也没有活着的串 → 一律不开口**：本地 ack 掉这条 entry，清空攒着的 `pendingText`，直接返回（连判官都不问）。
「主动搭话」不经过这里，它走 §10.1 的独立通道。

### 6.8 合并与冷却积压

- **归并窗口** `mergeWindowSec`（6s）：真人会把一句话拆成几条发，窗口内的先攒进 `pendingText`，窗口过去一起判、一起回；**@ 不参与合并**（不然会被吞）。
- **冷却挡住**（`canWake` 不通过）：这段里到达的消息**一条都不能丢**——攒进 `pendingText`（最多 12 条），等冷却过去由 `flushPending()` 一起补发（补发前再判一次值不值得）。

### 6.9 判官与空转抑制

- **判官** `judgeWorth()`（本地 4B，纯文本，约 0.15s）：判「这一轮**新来的**这几行值不值得接」；@ 已命中就不问；`quiet.enabled=false` 也不问。
- `decideQuiet()` 的固定顺序：

| 条件 | 结果 |
|---|---|
| 有 @ | 放行（必回） |
| 私聊 | 放行（对方就是直接跟她说话） |
| 主动搭话窗口（单窗口） | 放行 |
| 该会话在退避中 | 静默（问句可插队） |
| 判官 `yes` | 放行 |
| 判官 `no` | 静默 |
| 判官没给结论（退回传统 OCR / 格式不对） | 10 分钟内只放行一次（`quiet.unknownMin`）兜底 |

静默时把 entry 标已读、写 `poller-quiet.log`/`data/quiet.log`，不唤醒。

---

## 7. 唤醒闸门（`wake`）

`wake()` 是唯一的出口，顺序固定：

```
wake(cfg, reason, info)
 ├─ 0. 有 schedule 服务、wakeSessionId、autoReply.enabled？否则不叫
 ├─ 1. 不是 @？→ 从 inbox 找一条「5 分钟内、还没回、没被这次唤醒覆盖」的 @
 │       → 升级成 mention（mentionFrom=backlog）；多会话下必须按「当前会话」过滤，
 │         否则 A 群的 @ 会在 B 群的屏幕上把她叫醒、回复发错地方
 ├─ 2. canWake(chat)：到点放行；退避中只让问句插队；@ 能穿普通冷却，但上一次就是 @ 要守合并窗口
 ├─ 3. 串预算：同一条串 10 分钟内最多叫 6 次（私聊不受限）
 ├─ 4. 冷却：@ → mentionMergeSec；串内 → threadCooldownSec；普通 → wakeCooldownSec
 ├─ 5. 记账：nextAt / kind / proactiveAt / pendingSelf（串外唤醒先预登记，真发了再开 self 串）
 ├─ 6. buildWakePrompt() → schedule.create(800ms 后 → wakeSessionId)
 ├─ 7. 记 lastWake{chat, at, msgAt, mention}（供 settleLastWake 结算）
 └─ 8. scan.log 记一条 {why:"wake", build, mention, openNewTopic, mode}
```

冷却时长：

| 场景 | 参数 | 默认 | 笔记本现网 |
|---|---|---|---|
| @（同一波合并） | `mentionMergeSec` | 30s | 30s |
| 串内续聊 | `threadCooldownSec` | 20s | **35s** |
| 普通新消息 | `wakeCooldownSec` | 90s | 90s |
| 刚回过之后的静默 | `replyGapSec` | 45s | 45s |

### 7.1 Prompt 里写了什么

`buildWakePrompt()` 会**把判定结论直接写死**，不让模型自己回忆规则（以前就是每轮自己判断，结果变成「只有 @ 才回」）：

- 本轮新消息（本地已经读好，不再让她去 `wechat_inbox` 读一遍）；屏幕最近 6 条上下文；
- 讨论串信息：`[讨论串 t25] 还在进行（开始于 16 分钟前，起因：有人 @ 你）` + 「这一条是续聊，短反应/表情可以只 ack」；
- 跨会话隔离：只说这个会话的事，别处的人/话/八卦一律不许带进来；
- 发送规则：`wechat_send` 带 `chat:"<会话名>"`；找不到输入框就先 `wechat_open` 再发一次，仍失败就 ack；
- 收尾：发完同一轮里 `wechat_autoreply_state` + `wechat_inbox(ack)` 一起调掉；不想接也要 ack；
- 测试模式（`autoReply.dryRun=true`）：照常叫醒、照常判，但 `wechat_send` 被硬闸拦下，只把想说的话写出来。

模式差异：

| 情况 | prompt 结论 |
|---|---|
| 被 @ | 「必须回一句，这会开一个讨论串」 |
| 私聊 | 「对方直接跟你说话 → 回一句，不用等 @」 |
| 串活着（群） | 「本轮没有 @ 你，但讨论串 tN 还活着 → 可以接话（看内容值不值得，不是必须回）」 |
| 补发 @ | 「最近有 @ 你还没回 → 必须回」 |
| 冷却/归并攒下的 | 「这是刚才攒下的一条（不是新开话题）：接住它回一句」 |
| 主动搭话 | 「挑一个会话进去，主动开一个新话题；对方接了就在这条串里继续聊」 |
| 识图模式 | 「先 wechat_inbox 拿最新帧 → read_image 看图 → 自己判断有没有 @」 |

### 7.2 空转结算与退避

- 唤醒后等 `quiet.settleSec`（默认 45s）再结算：`lastSendAt > wakeAt` 才算「真的发出去了」；
- 发了 → 清零、记一条延迟（`latency.json`：`detect` 消息出现→唤醒，`think` 唤醒→发出），并按 `replyGapSec` 让该会话再静一会儿；
- 没发 → `empty++`；连续达到 `emptyWakesBeforeBackoff`（默认 3，笔记本 2）→ 该会话静默 `backoffMin`（5 分钟），`paused=true`，之后只有**问句**能插队叫醒。

---

## 8. 发送路径（`wechat_send`）

```
wechat_send(text, chat?)
 ├─ 测试模式（autoReply.dryRun=true）且非 dryRun → 直接拦下，只回显
 ├─ chat 核对（多会话关键闸）：
 │    ├─ 快路径：poller.recentChatTitle(20)，20 秒内确认过当前会话 → 直接发（省掉 2s 截图+OCR）
 │    ├─ 否则读当前标题；对不上 → 拒发并提示「先 wechat_open("chat")」
 │    └─ 没传 chat → 不核对（工具层旧行为；prompt 里要求必须带）
 ├─ 安全守卫 guard：长度 ≤200、禁止项正则（IP、盘符、adb、dsh、平台路径、序列号、用户名…）
 ├─ 限频 rateLimit：默认 5s / 每分钟 6 条 / 每小时 40 条
 ├─ 输入：点输入框 → MOVE_END → ADB_CLEAR_TEXT（清草稿）→ ADB_INPUT_TEXT
 ├─ 找绿色「发送」按钮（颜色检测）；找不到 → 退回配置固定坐标 coords.send
 ├─ 点发送 → 等 1.1s → 截图
 ├─ 收键盘（先收键盘再还原输入法，否则 BACK 会落到聊天页上）→ 还原百度输入法
 └─ recordSend：last-send.json（最近 12 条 + lastAt）→ 轮询器据此判断「她发出去了没有」
```

发送成功后，轮询器侧会产生三个副作用：

1. `lastSendAt` 变新 → `settleLastWake()` 记延迟、清空转；
2. 该会话下一次 `capture` 会把「发言那一刻屏幕上的行」写进 `preSend`，之后不再当新消息；
3. 有 `pendingSelf` 的会话立刻补开一条 `trigger=self` 的串。

---

## 9. 讨论串（Thread）生命周期

```
openThread(chat, trigger)      trigger = mention | self | dm
 ├─ mention：有人 @ → 开/续；把「@ 之前那几句」（同会话、y 在 @ 之上、最近 5 条）存为上下文
 ├─ dm：进私聊即开（TTL 用 dmThreadTtlMin=5 分钟）
 └─ self：她自己搭话，真的发出去了才成立
      · 主动搭话后的下一次识别：lastReplyAt 变新 → 开 self 串
      · 或 idleTick 里从列表预览里认出来（adoptSelfThread）
```

**续命 `lastAt`**：

| 模式 | 什么算「续命」 |
|---|---|
| 单窗口 | 这个群里任何新消息 |
| 多窗口·私聊 | 对方发来的每一条 |
| 多窗口·群聊 | @ 她 / 引用回复她 / 她自己 **3 分钟内**说过话；别人的闲聊不算 |

**关闭**：

- 闲置超过 TTL（群 `threadTtlMin`=10 分钟；私聊 `dmThreadTtlMin`=5 分钟）；
- 或超过 `threadMaxMin`（默认 0 = 关闭，可选硬上限）。

关掉时记 `lastThreadEndAt`（主动搭话的 30 分钟间隔从这里开始算）。
串状态落盘 `data/poller-threads.json`，插件热重载后还能接着用；最多保留 20 个会话的串。

---

## 10. 独立通道（不经过 capture 主判定）

### 10.1 主动搭话（`openNewTopic`）

- 触发：`idleTick` 里**没有候选**时检查 `proactiveDue()`：
  - `autoReply.proactiveInGroups === true`；
  - 距上一条串结束 ≥ `proactiveIntervalMin`（默认 30 分钟）；
  - 不在夜间安静期（`proactiveQuietFrom/To`，默认 23:30–08:00，跨午夜也能判）；
  - 本小时主动次数 < `proactiveMaxPerHour`（默认 3）。
- 动作：`proactiveCandidates()` 从当前列表挑候选（群=白名单；私聊=除黑名单；跳过文件传输助手/微信团队；最多 8 个）→ `wake("主动搭话", {openNewTopic:true, candidates})`。
- 模型自己选会话、`wechat_open` 进去、开新话题；这条会成为一条讨论串，对方接了就在串里继续。
- 每个会话各自记 `proactiveAt`，落盘 `data/proactive.json`（重启不清零，避免每个会话都「从没去过」立刻被选中）。

### 10.2 补发 @（`flushMentionBacklog`）

- 每个 tick 都查，但两个节流：上次唤醒 < `settleSec`(45s) 不催；10 秒内最多查一次；
- `takeBacklogMention()` 从 inbox 里找：`!read && mentionsMe && 5 分钟内 && 晚于 lastReplyAt && 晚于上次唤醒 && 补发次数 < 1`；
- 多会话下**必须**知道「现在人在哪个会话」，并只补发这个会话的 @；不知道会话就绝不补发（防止把 A 群的 @ 拿到 B 群屏幕上叫醒）；
- 补发唤醒的 prompt 会写成「必须回」。

### 10.3 攒批补发（`flushPending`）

- 冷却/归并窗口里攒下的 `pendingText`，到点后：
  - 必须仍在 `thread` 态、且 `pendingChat` 就是当前会话（否则屏幕不在这个会话，唤醒后 `wechat_send` 找不到输入框）；
  - 过 `canWake`；
  - 补判一次 `judgeWorth`，`no` 就直接丢掉；
  - 一起发一条，prompt 标注 `pending:true`（「冷却/归并里攒下的，不是新开话题」）。

### 10.4 会话轮换（`rotation`）

每 5 分钟检查（与聊天逻辑无关，会话只是上下文容器）：

- `rotation.enabled`；
- 当前唤醒会话轮数 ≥ `maxTurns`(300) 或体积 ≥ `maxSizeMB`(12)；
- 且存活 ≥ `minAgeMin`(60 分钟)、距上次轮换 ≥ `cooldownMin`(30 分钟)；
- → 建新会话 → 复制 `~/.dsh/fish-memory/<旧id>.json` 到新 id → 改 `wakeSessionId`（和主动搭话目标）→ 可选同步 speak-up。

---

## 11. 恢复、联动与运维

### 11.1 已知的「假活」与恢复

| 现象 | 判据 | 恢复 |
|---|---|---|
| 手机锁屏 | `mWakefulness` 不是 Awake/Dreaming | 记 `phone-locked`（10 分钟一次）后返回；**不重启微信** |
| 停在微信搜索页 | 焦点含 `FTS/Search` | back×2 + am start |
| 微信僵死（dumpsys 前台 / 截图桌面） | 连续 3 次回不到列表 | force-stop + monkey 拉起 |
| 识别失败 | OCR/模型抛错 | 本帧不算已处理（`lastHash=null`），下一轮重试；记 `lastError` |
| 探针不可用 | 连续 3 次读不到帧数 | `probeBroken=true`，退回慢轮单轮询 |

### 11.2 启停联动

- `autoReply.enabled=true` 保存 → `startPolling()`；false → `stopPolling()`；
- `startPolling` 若 `manageSpeakUp !== false` → 打开 `dsh-speak-up` 的「总开关」（否则「停了轮询」只停读屏，她还会主动发消息）；
- `stopPolling` **不带 token**（用户手动停）→ 关掉主动搭话；带 token（插件卸载/热重载）→ 不动它。

### 11.3 热重载

- `GET 127.0.0.1:65470/reload`（或 `/api/dsh-wechat-usb/reload-code`）：停轮询 → 重新 import **`lib/poller.js`** → 恢复 schedule → 再拉起；
  **只重载轮询器**：`index.js` / `lib/core.js` / `client.js` 的改动不会热生效，要重启插件（设置页开关）或 DSH 才会加载；
- `BUILD_ID` 每次 import 生成，`/poll.buildId` 能看到；每次唤醒写进 `scan.log`，用来识别「旧实例还在偷偷跑」；
- `fullTick` 开头有 `owner` 守卫：旧实例的定时器即使没被清掉，也不许再动；
- 热重载后 `api.js` 通过 `pollerRef.current` 取当前模块（否则 `/poll` 一直显示旧数据）。

### 11.4 状态与可观测

- `GET /status`：设备层（online/focus/awake/wechat/devices）；
- `GET /poll`：轮询器全景（running/buildId/schedule/current/list/thread/monitor/proactive/latency/quiet/errors/engine/fallback）；
- `GET /inbox`、`POST /inbox?action=ack`；`GET/POST /rotate`；`GET/POST /config`；`GET /sessions`；
- 设置页「运行状态」每 5 秒刷一次，数据就来自 `/poll`。

### 11.5 日志文件（`data/`）

| 文件 | 内容 |
|---|---|
| `scan.log` | 每轮扫描/唤醒/异常（含 build、why、mention、openNewTopic、mode） |
| `enter.log` | 进会话核对失败（点错会话/群不在白名单） |
| `mention-jump.log` | 「有人@我」跳转与是否停稳 |
| `quiet.log` / `poller-quiet.log` | 不唤醒的原因 |
| `poller-judge.log` | 判官调用耗时与结论 |
| `wake-error.log` | `schedule.create` 失败（以前静默吞掉，轮询在跑但一次没叫醒） |
| `chat-list.json` | 最近一屏列表行（带未读、群/私聊、y） |
| `poller-threads.json` | 讨论串（跨重载） |
| `chats.json` | 每个会话是群还是私聊（修正列表误判） |
| `latency.json` | 最近 30 条 detect/think |
| `proactive.json` | 每会话上次主动搭话时间（7 天） |
| `seen.json` | 30 分钟去重缓存 |
| `last-send.json` | 最近 12 条自己发的内容 + lastAt |
| `inbox/index.json` | 待处理帧（read/mentionsMe/mentionWakes） |

---

## 12. 触发条件总表（一页速查）

| 信号 / 事件 | 判据 | 动作 |
|---|---|---|
| 慢轮到点 | 距上次完整轮 >1.5s | `fullTick` |
| 快轮帧数变化 | 多会话只在 thread 态 | `fullTick` |
| 列表轮到点 | 多会话 + idle 态 | `idleTick` |
| 手机锁屏 | `mWakefulness` 非 Awake | 记日志，本轮结束 |
| 列表里某会话 | 未读>0 且预览变了 且不在冷却 | 进这个会话（搜索优先） |
| 无候选 + 主动搭话到点 | 30min / 非夜间 / 1h≤3 / 开关开 | 唤醒，让模型挑会话开新话题 |
| 进会话点错 | 标题与目标不符 | back，重扫重试一次；2 次冷却 |
| 进群未授权 | 群不在 `whitelistChats` | back，冷却 ≥10 分钟 |
| 带未读进群 | 未读≥4 且屏里没 @ | 点「有人@我」跳转，等滚动停 |
| 读屏没变化 | 哈希相同 | 不 OCR，结束 |
| 同一处还在动 | `frame_diff` 变化带窄且中心没挪 | 图片描述不算新消息 |
| 新内容被去重 | 自己发的 / seen 30min / 早于发言 | 丢弃 |
| 有 @ | 整屏 @ 行首次出现晚于上次发言/上次@唤醒 | 开/续串，必回 |
| 私聊有新内容 | 对方每条都算 | 必回，不过判官 |
| 群串活着 + 对着她说 | @ / 引用她 / 她 3min 内说过话 | 可以接（判官） |
| 群串活着 + 别人闲聊 | 不对着她说 | 不续命、不叫醒 |
| 群里没 @ 也没串 | 多会话硬闸 | ack 回列表，连判官都不问 |
| 判官说值得 | `verdict=yes` | 放行唤醒 |
| 判官说不值得 | `verdict=no` | 静默 |
| 判官没结论 | 10 分钟内只放行一次 | 静默/放行 |
| 冷却中 | `canWake=false` | 消息攒进 `pendingText` |
| 被 @ 但冷却 | @ 能穿普通冷却 | 升级 mention 补发 |
| 叫醒后 90s | 她发出去了 / 超时 | 回列表 |
| 唤醒没人发 | `lastSendAt <= wakeAt` | 空转 +1，达标退避 5 分钟 |
| 她主动搭话 | `lastReplyAt` 变新 / 列表预览命中自己 | 补开 `self` 串 |
| 长会话 | 300 轮 / 12MB | 建新会话、搬记忆、改绑定 |

---

## 13. 参数总表（默认 vs 笔记本现网 2026-11-15）

| 参数 | 默认 | 现网 | 作用 |
|---|---|---|---|
| `autoReply.enabled` | false | **true** | 自动回复总开关 |
| `autoReply.intervalSec` | 15 | **30** | 慢轮 |
| `autoReply.probeSec` | 4 | 4 | 快轮（帧计数） |
| `autoReply.wakeCooldownSec` | 90 | 90 | 普通唤醒冷却 |
| `autoReply.mentionMergeSec` | 30 | 30 | @ 合并窗口 |
| `autoReply.threadCooldownSec` | 20 | **35** | 串内续聊冷却 |
| `autoReply.replyGapSec` | 45 | 45 | 刚回完的静默 |
| `autoReply.mergeWindowSec` | 6 | 6 | 拆句归并窗口 |
| `autoReply.threadTtlMin` | 10 | 10 | 群串闲置 TTL |
| `autoReply.dmThreadTtlMin` | 5 | 5 | 私聊串闲置 TTL |
| `autoReply.threadMaxMin` | 0（关） | 0 | 串硬上限 |
| `autoReply.threadGapSec` | 20 | 20 | **目前已不参与判定**（旧参数，`gapMs` 未被使用） |
| `autoReply.noMentionIntervalMin` | 30 | 30 | 单窗口「无 @ 参与」间隔 |
| `autoReply.proactiveInGroups` | false | **true** | 主动搭话总开关 |
| `autoReply.proactiveIntervalMin` | 30 | 30 | 主动搭话间隔（从上次串结束算） |
| `autoReply.proactiveQuietFrom/To` | 23:30 / 08:00 | 同 | 夜间安静期 |
| `autoReply.proactiveMaxPerHour` | 3 | 3 | 每小时主动次数 |
| `autoReply.proactiveDmBlacklist` | [] | [] | 不主动去的私聊 |
| `autoReply.whitelistChats` | []（不限） | 摸鱼…、群… | 群聊准入名单 |
| `autoReply.mentionKeywords` | — | @小助手 / @小助手 / @小助手 | @ 命中词 |
| `autoReply.manageSpeakUp` | true | **false** | 启停是否联动 speak-up |
| `autoReply.dryRun` | false | false | 测试模式（不发真消息） |
| `autoReply.autoOpen` | true | true | 单窗口自动切回目标会话 |
| `quiet.enabled` | true | true | 空转抑制 |
| `quiet.unknownMin` | 10 | 10 | 没判词时的兜底静默 |
| `quiet.settleSec` | 45 | 45 | 唤醒后多久结算 |
| `quiet.emptyWakesBeforeBackoff` | 3 | **2** | 连续空转几次退避 |
| `quiet.backoffMin` | 5 | 5 | 退避时长 |
| `multi.enabled` | **true** | true | 多会话/单窗口 |
| `multi.listScanSec` | 15 | 15 | 列表扫描间隔 |
| `multi.perChatCooldownSec` | 90 | 90 | 离开会话后的冷却 |
| `multi.enterSettleMs` | 500 | 500 | 点行后等页面切换 |
| `multi.enterBySearch` | true | 未写=默认 true | 搜索优先进入 |
| `multi.scrollSampleMs` | 400 | 400 | @ 跳转后采样帧间隔 |
| `multi.scrollStableFrames` | 2 | 2 | 连续几帧一致算停 |
| `multi.scrollTimeoutMs` | 5000 | 5000 | 等滚动停上限 |
| `multi.maxScrollScreens` | 3 | 3 | 滑到底次数 |
| `rotation.enabled` | 关 | **true** | 会话轮换 |
| `rotation.maxTurns/maxSizeMB` | 300 / 12 | 同 | 触发轮换的体量 |
| `rotation.minAgeMin/cooldownMin` | 60 / 30 | 同 | 轮换的最小年龄/冷却 |
| `ocr.engine` | rapidocr | **qwen-vl** | 识别引擎 |
| `ocr.vlModel` | qwen3-vl:4b-instruct | 同 | 本地 4B |
| `policy.maxChars/minIntervalMs/maxPerMinute/maxPerHour` | 200 / 5000 / 6 / 40 | 同 | 发送守卫 |

---

## 14. 竞态与防护

| 竞态 | 现象 | 防护 |
|---|---|---|
| 列表在「截图→点击」间重排 | 点到隔壁会话 | 搜索优先 + 读标题核对；失败重扫一次；`enter.log` |
| 叫醒后屏幕被切走 | 消息发到别的会话 | `wechat_send` 带 `chat` 核对；90s hold 不切窗口 |
| 识别措辞抖动 | 同一条 @ 反复命中 | @ 判定按「首次出现时间」；seen 30min；Jaccard 容错 |
| 识图描述每帧变 | 差分永远有新内容 → 唤醒风暴 | `〔图片〕` 归一；只剩图片描述不叫醒；串预算 6 次/10min |
| 热闹的群 | 串永远不散 | 只有「对着她说」才续命；她 3 分钟内的气泡才算 |
| 群里没 @ | 判官说「有意思」就开口 | 多会话硬闸：非 @/非私聊/无串 → 不判官、不叫醒 |
| 冷却吞消息 | @ 落在 90s 冷却里 | @ 短窗口 + inbox 补发；冷却期消息进 `pendingText` |
| 旧实例 | 热重载后两份定时器 | `BUILD_ID` + `owner` 守卫 |
| 手机锁屏 | 8 小时空转 | 亮屏检查，记一次日志就返回 |
| 停在搜索页 | 回不到列表 | FTS 专门处理：back×2 + am start |
| 微信僵死 | 截图全是桌面 | 连续 3 次才 force-stop 重启 |

---

## 15. 已知边界 / 待办

1. **只支持一个前台会话**：这是手机微信的物理限制，多窗口并行聊天做不到，也不该做。
2. **读屏有信息损失**：未读只数到「有/无」；@ 靠 OCR 命中关键词；长消息会被截断成屏内行。
3. **列表「群/私聊」是猜的**：靠 `(N)` / 预览冒号 / `chats.json` 修正；私聊误判成群的代价是「被当成群里，不敢回」。
4. **@ 跳转依赖「有人@我」标签**：未读 <4 或标签不在顶部时不跳转，直接看当前屏。
5. **主动搭话**是独立插件（speak-up）发的消息，轮询器只能从 `lastReplyAt` / 列表预览事后认领。
6. `threadGapSec` 已无实际作用，可考虑清理。
7. 识别引擎 `windows` 保留为兜底（设置页可选），多会话主链路主要用 `qwen-vl` / `rapidocr`，未单独压测。
8. 夜间安静期只约束「主动搭话」，不约束 @ / 私聊回复。
9. 旧版 `docs/wechat-multichat-design.md` 是设计草案（未落地时的文字），与现在的实现有出入，以本文为准。

---

## 16. 单窗口模式（`multi.enabled=false`）与多窗口的差异

| 行为 | 单窗口（=v0.3.1） | 多窗口（当前默认） |
|---|---|---|
| 目标会话 | 死盯 `whitelistChats[0]` | 巡场，谁有新消息去谁那 |
| 不在目标会话 | `tryAutoOpen` 回列表→搜索→点第一条，失败退避 | `idleTick` 负责导航；capture 不拽屏幕 |
| 快轮 | 一直跑 | 只在 thread 态跑 |
| 列表扫描 | 不扫 | 15s 一次 |
| 串续命 | 群里任何新消息 | 只认「对着她说」 |
| 群里没 @ | 到 `noMentionIntervalMin` 可以主动搭一句（v1 行为） | **一律不开口**；主动搭话走独立通道 |
| 进会话 | 不涉及 | 搜索优先 + 标题核对 + 冷却 |
| 私聊 | 不区分 | 进来即开 dm 串，必回 |
| 唤醒后 | 没叫醒就继续盯 | 没叫醒就回列表 + 冷却 |

---

## 17. 版本变更（相对 2026-11-14 的 `842718d`）

2.0 落地后这一天的关键修复，都已体现在上面的流程里：

| 提交 | 修了什么 | 流程上的变化 |
|---|---|---|
| `607fdae` | 夜间安静期 | 主动搭话在 23:30–08:00 不触发 |
| `788b78f` | 唤醒写 build + 旧实例守卫 | 每次唤醒可追溯到版本；旧定时器不再动 |
| `fad95f1` | 攒批补发的 prompt 措辞 | `pending` 唤醒不再说成「主动搭一句」 |
| `e0defaa` | 群里没 @ 也开口 | 多会话硬闸：非 @/非私聊/无串 → ack，不问判官 |
| `9b1195d` | 串永远散不掉 | 自己的绿气泡只在 3 分钟内算「对着她说」 |
| `537141a` | 热重载后 `/poll` 仍旧数据 | api.js 走 `pollerRef.current` |
| `2c358c5` | 锁屏 8 小时空转、卡搜索页 | 亮屏检查；FTS 双 back + am start |
| `f957281` | 会退到桌面、群里 @ 漏、发送慢 2s | 像素探针判页；@ 改为整屏按时间；发送核对走内存缓存 |

更早的 2.0 变更（多会话、串、轮换、判官）见 `CHANGELOG.md` 与 `docs/RELEASE-2.0.0.md`。