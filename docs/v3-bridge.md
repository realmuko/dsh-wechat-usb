# v3.0 桥接：主模型当脑子，引擎当手

> 2026-11-17 · 对应 `lib/bridge.js`、`index.js` 里的两个新工具
> 目标：保留旧插件最值钱的一环（叫醒 DSH 会话、主模型带着记忆说话），把「怎么操作手机」交给引擎。

## 一条链路

```
微信新消息
   ↓（引擎：红点扫描 → 进会话 → OCR 读尾部 → 去重 → 策略）
   ↓
引擎发现「该回了」→ 挂成待办（GET /pending）
   ↓（插件 bridge：每 8 秒轮询，发现新待办）
schedule.create 叫醒会话，prompt 里带会话名 + 最近 8 条 + 待办 id
   ↓（主模型：读上下文 → 回文本 / 回表情 / 沉默）
工具调用 wechat_reply_pending({id, text})
   ↓（插件 POST /pending/reply）
引擎：切输入法 → 打字 → 点发送 → 记事件
```

## 为什么要拆成两半

- **引擎**：需要确定、可测、可回放的东西——红点怎么认、消息怎么去重、什么时候不该回。
- **会话**：需要「像她」的东西——语气、记忆、这个人能不能开玩笑。这部分只有在 DSH 里才有。
- 不做的事：不让引擎编话（本地 4B 说话太差），也不让插件碰 adb（旧 poller 的教训）。

## 怎么启用

`wechat-usb.config.json` 加：

```json
{
  "bridge": {
    "enabled": true,
    "engineUrl": "http://127.0.0.1:65480",
    "sessionId": "<要叫醒的 DSH 会话 id>",
    "intervalMs": 8000
  }
}
```

然后**重启插件**（改的是 `index.js`，热重载只覆盖 poller）。同时：

1. 启动引擎：`node <mimicd 仓库>/tools/daemon.ts --adb "<adb>" --interval 20`
2. 关掉旧 poller（`POST /poll {"action":"stop"}` 或设置页停掉）——**两个执行者不能同时碰手机**。

## 工具

| 工具 | 作用 |
|---|---|
| `wechat_reply_pending({id, text})` | 把主模型写的那句话交给引擎发出 |
| `wechat_skip_pending({id, reason})` | 这条不接，理由落进引擎事件 |

两个工具在桥接未启用时会明确报错，不会静默失败。

## 已验证 / 未验证

- **已验证**（`test/bridge-selftest.mjs`）：提示词内容、去重（同一待办不重复唤醒）、唤醒调用形状（`timing` + `target.sessionId`，失败回退旧签名）、回复/跳过的请求体、没有 sessionId 时报错。
- **未验证**：`schedule.create` 在真实 DSH 里的返回与唤醒效果——需要重启插件后，用一条真实的待办试一次。

## 回滚

- 配置里 `bridge.enabled=false` + 重启插件即可；旧 poller 的逻辑一行没删，随时可以开回去。
- 分支 `v3`，`main` 保持 2.x。