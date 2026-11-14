# 微信 USB 插件 · 架构与触发链路

> 版本：2026-11-14（`842718d` 之后）
> 两种模式：**单窗口**（`multi.enabled = false`，= v0.3.1 行为） / **多窗口**（`multi.enabled = true`，当前默认）
> 单窗口细节见 [`single-window-design.md`](single-window-design.md)；多窗口设计见 [`wechat-multichat-design.md`](wechat-multichat-design.md)

---

## 1. 顶层结构

```
┌──────────────┐   ADB (USB)   ┌───────────────────────┐   HTTP 127.0.0.1:65470   ┌──────────────┐
│  Android 手机 │◄─────────────►│  dsh-wechat-usb 插件    │◄────────────────────────►│ 设置页 (GUI)  │
│  微信 8.x     │  截图/点击/输入 │  lib/poller.js  轮询器   │                          └──────────────┘
└──────────────┘               │  lib/core.js    ADB 能力 │
                                │  lib/rotation.js 会话轮换│
                                └───────────┬───────────┘
                                            │ schedule.create（一次性唤醒）
                                            ▼
                                ┌───────────────────────┐
                                │ DSH 会话（wakeSessionId）│──► 模型判断要不要回
                                └───────────┬───────────┘
                                            │ wechat_send(text, chat?)
                                            ▼
                                     回到手机上的微信窗口
```

三条边：

1. **看**：`adb screencap` → 本地 OCR（rapidocr / windows / qwen-vl）→ 文本行 + 坐标；
2. **想**：把「新消息 + 会话名 + 规则」拼成 prompt，通过 `schedule.create` 投给 DSH 会话；
3. **做**：模型调 `wechat_send`，插件校验目标会话、过安全守卫、点发送。

---

## 2. 谁在什么时候跑（定时器）

| 定时器 | 间隔 | 模式 | 作用 |
|---|---|---|---|
| 慢轮 `intervalSec` | 15 / 30 秒 | 两种 | 兜底：不管屏幕变没变都跑一次 `fullTick()` |
| 快轮 `probeSec` | 4 秒 | 两种 | 只读微信渲染帧计数（~140ms）；**变了才**截图跑 `fullTick()`；多窗口的空闲态跳过 |
| 列表轮 `listScanSec` | 15 秒 | 仅多窗口 | 空闲时扫一次聊天列表；线程态跳过 |
| 轮换检查 | 5 分钟 | 两种（需开） | 会话上下文超阈值就新建会话 + 搬记忆（见 §8） |

`fullTick()` 的分派：

```
fullTick(cfg)
 ├─ flushMentionBacklog()   补发还没回的 @（按当前会话过滤）
 ├─ flushPending()          冷却期间攒下的消息（必须"人就在这个会话里"）
 └─ if (multi.enabled) {
       mode === "thread" ? (串活着 or 还在 hold → capture) : (回列表 → idleTick)
    } else {
       capture()      // 单窗口：始终对着 whitelistChats[0]
    }
```

---

## 3. 单窗口模式（`multi.enabled = false`，v0.3.1）

```mermaid
flowchart TD
    A[fullTick] --> B{capture}
    B --> C{前台是微信?}
    C -- 否 --> Z1[结束]
    C -- 是 --> D{停在 whitelistChats[0]?}
    D -- 否 --> E[tryAutoOpen: 回列表→搜索→点第一条]
    E --> Z1
    D -- 是 --> F[截图 + 哈希]
    F --> G{和上一帧一样?}
    G -- 是 --> Z1
    G -- 否 --> H[动图判定 frame_diff]
    H --> I[OCR 逐行]
    I --> J[差分: 只留新行 → seen 去重 → 去掉自己发的]
    J --> K{有新内容?}
    K -- 否 --> Z1
    K -- 是 --> L[@ 命中? / 串活着? / 距上次发言 ≥ noMentionIntervalMin?]
    L --> M[本地 4B 判官 judge_worth]
    M --> N{decideQuiet}
    N -- quiet --> O[ack 标已读, 不叫醒]
    N -- 放行 --> P[wake: schedule.create → DSH 会话]
```

### 触发条件表（单窗口）

| 条件 | 结果 |
|---|---|
| 前台不是微信 | 本轮结束 |
| 不在目标群 | `tryAutoOpen`（回列表 → 搜索 → 点第一条）；连续失败退避 5 分钟 |
| 屏幕没变化 | 不 OCR，结束 |
| 同一处还在动（动图） | 图片描述行不当新消息 |
| 新内容被 `seen`(30 分钟) / 自己 15 分钟内发过 | 丢弃 |
| 有 @ | 必回（跳过判官） |
| 串活着 + 有新内容 | 可以接（判官决定）；**任何新消息都续命** |
| 无 @、无串，距上次参与 ≥ `noMentionIntervalMin` | 可以主动搭一句 |
| 以上都不满足 | 只 ack |

---

## 4. 多窗口模式（`multi.enabled = true`）

### 4.1 状态机

```
        ┌─────────────────────────── IDLE ───────────────────────────┐
        │ 每次 listScanSec：回列表 → 扫列表 → 挑一个会话               │
        │   条件：未读>0 且 预览文字变了 且 不在 perChatCooldown 里     │
        │   排序：@提示 > 私聊 > 群聊                                  │
        └───────────────┬────────────────────────────────────────────┘
                        │ 点行 → 等 enterSettleMs → 读标题核对
                        ▼
                    ┌ ENTER ─┐  标题对不上 → 重扫重试一次（连续两次才冷却）
                    │        │  是群且不在白名单 → 退出来 + 冷却 10 分钟
                    └───┬────┘
                        │ 带未读进来的先滑到底（3 次 swipe）
                        │ 私聊：立刻开串(trigger=dm)
                        ▼
                    ┌ READ ─┐  capture()：截图→OCR→差分→判官
                    └───┬───┘
            放行唤醒 ───┤
                        ▼
                    ┌ THREAD ┐ 钉在这个会话：串活着 或 还在 90s hold 内 → 继续 capture
                    └───┬────┘
        串散了 / 已经发出去了 ┘ → 回 IDLE
```

### 4.2 一次进会话的完整时序

```
listScanSec 到
  ├ ensureChatList()          焦点=LauncherUI 且第 2 次复核仍含「微信」才继续
  ├ scanChatList()            截图 → 校验是列表 → Windows OCR(x≥190) → 解析行 → 数红色像素
  ├ filterAllowed()           私聊放行；群必须在 whitelistChats
  ├ chooseCandidate()         未读>0 + 预览变化 + 冷却
  ├ enterChat()               tap 行中心 → 等 500ms → 读标题
  │    ├ 标题 ≠ 目标          记 enter.log，退回，重扫重试一次
  │    ├ 标题是群且未授权      退回，冷却 10 分钟
  │    └ 通过                 （群/私聊类型以标题里的「(N)」为准）
  ├ scrollToBottom()          带未读进来时微信停在第一条未读，先滑到底
  ├ 私聊 → openThread(dm)
  ├ capture()                 读屏 → 差分 → 判官 → 决定叫不叫
  └ 叫醒了 → hold 90 秒（等她写完发出去）；没叫醒 → 回列表 + perChatCooldownSec
```

### 4.3 触发条件表（多窗口）

| 事件 | 判断 | 动作 |
|---|---|---|
| 空闲到点 | 列表里某会话 `未读>0` 且预览变了 且不在冷却 | 进这个会话 |
| 进会话 | 标题对不上（列表在截图→点击之间重排） | 退回，立刻重扫重试一次 |
| 进会话 | 群且不在白名单 | 退回，冷却 10 分钟 |
| 读屏后 | 有 @ | 开/续串 → 必回 |
| 读屏后 | 私聊有新内容 | 必回（不过判官） |
| 读屏后 | 群串活着 + 内容是"对着她说的" | 可以接（判官） |
| 读屏后 | 群串活着 + 只是别人闲聊 | **不续命，不叫醒** |
| 读屏后 | 无 @、无串 | 默认只看不回（`proactiveInGroups` 才主动开口） |
| 叫醒后 | 90 秒内她发出去了（`lastSendAt` 变化） | 这一轮结束就回列表 |
| 叫醒后 | 90 秒没发 | 超时回列表 |

---

## 5. 唤醒判定阶梯（两种模式共用，顺序固定）

```
wake(cfg, reason, info)
 │
 ├─ 1. 有 @ ?                → 放行（mention）
 ├─ 2. 私聊 ?                → 放行（dm）
 ├─ 3. 主动搭话窗口 ?          → 放行（proactive；多窗口需显式开）
 ├─ 4. 串活着 + 判官说值得 ?   → 放行（thread）
 ├─ 5. 判官说值得 ?           → 放行（idle）
 └─ 6. 判官没结论 ?           → 兜底静默 unknownMin(10 分钟)
```

放行之后还有三道闸：

| 闸 | 条件 | 默认 |
|---|---|---|
| 会话冷却 `canWake` | 距上次唤醒 < 该会话的 `nextAt`；@ 能穿过"普通"冷却，但穿不过"@ 冷却" | — |
| 串唤醒预算 | 同一条串 10 分钟内最多 6 次（私聊不受限） | 6 次 |
| 刚回过静默 | 她刚发过 → 该会话再等 `replyGapSec` | 45 秒 |

冷却时长：

| 场景 | 参数 | 默认 |
|---|---|---|
| @ | `mentionMergeSec` | 30 秒（合并窗口） |
| 串内续聊 | `threadCooldownSec` | 20 秒（笔记本配置 35 秒） |
| 普通新消息 | `wakeCooldownSec` | 90 秒 |
| 主动搭话（每会话各自） | `noMentionIntervalMin` | 30 分钟 |

---

## 6. 讨论串（Thread）

```
openThread(trigger)      trigger = mention | self | dm
   │
   ├─ mention：有人 @ → 把「@ 之前那几句」当上下文
   ├─ self：她自己主动搭话，真的发出去了才成立
   └─ dm：进私聊即开
   │
   ├─ 续命（lastAt = now）
   │    单窗口：群里有任何新消息
   │    多窗口：@ / 引用回复她 / 她自己说话 / 私聊里对方每条
   │
   └─ 关闭
        ├─ 闲置 > ttl（群 threadTtlMin 10 分 / 私聊 dmThreadTtlMin 5 分）
        └─ 超过 threadMaxMin（默认 0 = 关闭）
```

`@` 去重：同一句 @ 的指纹 =「会话 + 去掉标点后前 12 字」，15 分钟内只算一次新的。

---

## 7. 发送路径（多窗口的关键闸）

```
wechat_send(text, chat?)
  ├ dryRun 配置开着 → 直接拦下，只回显
  ├ 带 chat → 读当前屏幕标题，和 chat 对不上 → 拒发并提示先 wechat_open
  ├ 安全守卫（主机信息 / 路径 / 频率）
  ├ 输入：点输入框 → 清空 → ADB_INPUT_TEXT
  ├ 找发送按钮（绿色）；找不到 → 退回配置里固定的 coords.send
  ├ 点发送 → 等 1.1s → 截图
  └ 记录到 last-send.json（轮询器据此判断"她发出去了没有"）
```

---

## 8. 会话轮换（上下文维护）

```
每 5 分钟：
  rotation.enabled ?
  ├ 当前唤醒会话 轮数 ≥ maxTurns(300) 或 体积 ≥ maxSizeMB(12)
  ├ 且 存活 ≥ minAgeMin(60 分)、距上次轮换 ≥ cooldownMin(30 分)
  └ → 建新会话 → 复制 fish-memory/<旧>.json → 改 wakeSessionId + 主动搭话目标会话
```

与聊天的关系：**无关**。会话只是上下文容器；换的时候她可能正在某个讨论串里聊，串的状态在插件里，不受影响。

---

## 9. 参数总表（按模式归属）

| 参数 | 默认 | 单窗口 | 多窗口 |
|---|---|---|---|
| `autoReply.enabled` | false | 开轮询 | 开轮询 |
| `multi.enabled` | true | **关**（= 本表的单窗口列） | 开 |
| `multi.listScanSec` | 15 | 不用 | 扫列表间隔 |
| `autoReply.whitelistChats` | `[]` | 只认第 1 个 | 群聊准入名单（空 = 不限） |
| `autoReply.threadTtlMin` | 10 | 闲置 TTL | 群串闲置 TTL |
| `autoReply.dmThreadTtlMin` | 5 | 不用 | 私聊串闲置 TTL |
| `autoReply.threadCooldownSec` | 20 | 串内冷却 | 串内冷却 |
| `autoReply.mentionMergeSec` | 30 | @ 合并窗口 | @ 合并窗口 |
| `autoReply.replyGapSec` | 45 | 回完静默 | 回完静默 |
| `autoReply.proactiveInGroups` | false | **忽略（v1 照旧主动）** | 群里没 @ 是否开口 |
| `autoReply.noMentionIntervalMin` | 30 | 主动参与间隔 | 主动开口间隔（需开关） |
| `autoReply.wakeCooldownSec` | 90 | 普通冷却 | 普通冷却 |
| `autoReply.probeSec` | 4 | 快轮 | 快轮（空闲态跳过） |
| `multi.perChatCooldownSec` | 90 | 不用 | 离开某会话后的冷却 |
| `rotation.*` | 关 | 可用 | 可用 |

---

## 10. 已知竞态与防护

| 竞态 | 现象 | 防护 |
|---|---|---|
| 列表在"截图→点击"之间重排 | 点到隔壁会话 | 读标题核对；mismatch → 重扫重试一次 |
| 叫醒后屏幕被切走 | 消息发到别的会话 | `wechat_send` 带 `chat` 校验；hold 90 秒不切 |
| OCR 措辞抖动 | 同一条 @ 反复命中 | @ 指纹（前 12 字，15 分钟） |
| 识图描述每帧变 | 差分永远有新内容 → 唤醒风暴 | 归一成 `〔图片〕` |
| 热闹的群 | 串永远不散 | 只认"对着她说的"续命 |
| 微信僵死（dumpsys 说在前台、截图是桌面） | 轮询空转 | 连续 3 次失败 → force-stop + 重开微信 |
| 补发唤醒人不在会话 | 「找不到发送按钮」 | 只在 thread 态且 current 匹配时补发 |

---

## 11. 文件映射

| 文件 | 职责 |
|---|---|
| `lib/poller.js` | 轮询、状态机、讨论串、唤醒、发送编排（核心） |
| `lib/core.js` | ADB 能力（截图/点击/输入/发送）、配置、守卫、限频 |
| `lib/sessions.js` | 列本机会话（设置页下拉） |
| `lib/rotation.js` | 会话轮换（建会话、搬记忆、改绑定） |
| `lib/vl_ocr.py` / `judge_worth.py` / `ocr.ps1` / `badge_probe.py` | 识别与判定 |
| `index.js` | 工具注册（wechat_*）、HTTP 路由、插件生命周期 |
| `client.js` | 设置页（React） |
| `lib/api.js` | 设置页用的独立本机 API（65470） |