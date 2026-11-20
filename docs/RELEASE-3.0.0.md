# 3.0.0 — 交接桥接

> 2026-11-20 · 对应 `lib/bridge.js`、`lib/rotation.js`、`index.js` 的桥接工具
> 分支：`main` = 3.0；`v2` = 2.0 多会话；标签 `v0.3.1` = 单会话基线。

## 一句话

以前是插件自己开着 poller 读屏、判官、唤醒、发消息；3.0 把这套拆成两半——
**感知与执行交给引擎（mimicd），说话交给 DSH 会话（主模型）**。

```
微信新消息
   ↓ 引擎：红点扫描 → 进会话 → 读尾部 → 去重 → 静默/频率策略
引擎发现「该回了」→ 挂成待办（GET /pending）
   ↓ 插件：每 8s 轮询，只挑没见过的 id
schedule.create 叫醒会话（prompt 带上下文 + 待办 id）
   ↓ 主模型：回一句 / 回表情 / 沉默
wechat_reply_pending / wechat_skip_pending
   ↓ 插件 POST /pending/reply
引擎：切输入法 → 打字 → 点发送 → 记事件
```

## 为什么拆

- **引擎**需要确定、可测、可回放：红点怎么认、消息怎么去重、什么时候不该回、安静时段、限额。
- **会话**需要「像她」：语气、记忆、跟这个人能不能开玩笑——这部分只有在 DSH 里才有。
- 不做的两件事：不让引擎编话（本地 4B 说话太差），也不让插件碰 adb（旧 poller 的教训）。

## 新增工具

| 工具 | 作用 |
|---|---|
| `wechat_reply_pending` | 交回一句话 / 一个表情 / 文字+表情 |
| `wechat_skip_pending` | 不接，理由落进引擎事件 |
| `wechat_read_link` | 让引擎打开会话里的链接/文章，读回标题与正文 |
| `wechat_chats` | 最近聊过谁（挑主动搭话对象） |
| `wechat_stickers` | 表情库情绪与数量 |
| `wechat_say` | 主动搭话（安静时段/限额/群聊开关在引擎侧） |
| `wechat_autoreply_state` | 读写自动回复时间戳，可传 `"now"` |

桥接未启用时这些工具会明确报错，不会静默失败。
反过来，`bridge.enabled: true` 时设备工具（`wechat_shot` / `open` / `send` / `watch` / `poll_*`）一律拒绝——**单写者纪律**。

## 配置

```json
{
  "bridge": { "enabled": true, "engineUrl": "http://127.0.0.1:65480", "sessionId": "<DSH 会话 id>", "intervalMs": 8000 },
  "rotation": { "enabled": true, "maxTurns": 300, "maxSizeMB": 12, "minAgeMin": 60, "cooldownMin": 30 }
}
```

- 改的是 `index.js`，装完要**重启插件**（热重载只覆盖 poller）；
- 引擎侧启动：`node <mimicd 仓库>/tools/daemon.ts --adb "<adb>" --interval 20`；
- 旧 poller 必须停掉，两个执行者不能同时碰手机。

## 稳定性

- **叫醒超时 25s**：`schedule.create` 挂住不再拖死 `#busy`；超时的那次不用旧签名重试，避免重复唤醒。
- **看门狗 60s**：`#busy` 超过 60s 没进展强制复位并记一笔，下一拍重新开始。
- **失败重试有上限**：同一待办最多叫 3 次，之后标记已处理，写 `data/bridge.log`。
- **启动日志**：轮询间隔 / 看门狗阈值 / 叫醒超时都会打进 `bridge.log`，出了问题先看这一行。
- **按动作分超时**：轮询 10s、回复/主动搭话 180s、读链接 240s（动作类超时最糟：会话以为失败，引擎其实已经发出去了）。

## 唤醒提示词里有什么

- 会话名 + 群聊/私聊；
- 最近 8 条：`我` / `对方` / 群聊里的 `发送者昵称`；
- 群聊且有接话口时，提示「可以主动接，不用等 @」；
- 消息里有链接时，给出 `wechat_read_link` 的调用示例；
- 表情库概况（情绪 + 张数）；
- 待办 id + `wechat_reply_pending` / `wechat_skip_pending` 的调用示例；
- 说话规矩：不超过 60 字、口语、别暴露 AI、别加引号、该发表情就发。

## 会话轮换

- 按轮数/体积触发（默认 300 轮或 12MB，最短存活 60 分钟，冷却 30 分钟）；
- 同工作区建新会话，工作区记忆共用一份，**不用复制文件**（按会话模式才复制）；
- 轮换后 `bridge.setSessionId()` 原地切绑定，不用重载插件；
- 引擎还有待办时不轮换。

## 测试

```bash
npm run check
node test/bridge-selftest.mjs
npm test
```

## 升级与回退

- 从 2.0 升上来：拉 `main` → 配置里加 `bridge`（`enabled/sessionId`）→ 重启插件 → 启动引擎 → 停掉旧 poller。
- 回退 2.0：`git checkout v2`，配置去掉 `bridge`，重启插件。
- 回退 1.x：`git checkout v0.3.1`。
- 3.0 自身回滚：`bridge.enabled=false` + 重启，旧 poller 逻辑一行没删。