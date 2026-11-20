# dsh-wechat-usb

把“USB 连着的真机微信”变成 DSH 工具。

**3.0（当前 `main`）换了分工：引擎当手，DSH 会话当脑子。**
感知、去重、静默时段、点按发送交给外部引擎（mimicd）；插件只做两件事——轮询引擎的待办、叫醒一个 DSH 会话，
再把主模型写好的那句话交回引擎发出。这样既保留了「她本人带着记忆和人格说话」，又不再让插件自己碰 ADB。

> 3.0 之前的两个版本仍然完整保留：`v2` 分支是多会话巡场（插件自己 ADB + OCR 读屏、判官、讨论串），
> 标签 `v0.3.1` 是单会话基线。回退方式见文末「版本与分支」。

> 设计参考了社区的 [`dsh-phone-butler`](https://www.npmjs.com/package/dsh-phone-butler)：
> **零 `@deepseek-ai/*` import**（`link:` 安装的插件解析不到这些包，一个 import 会让整个插件加载失败）；
> 工具用原始 JSON Schema 直接 `ctx.tools.register`；技能用 `ctx.skills.registerProvider` 随包提供。

## 快速开始（3.0 交接模式）

```bash
git clone https://github.com/realmuko/dsh-wechat-usb.git
cd dsh-wechat-usb
cp wechat-usb.config.example.json wechat-usb.config.json   # Windows: copy
```

编辑 `wechat-usb.config.json`，至少填上 `bridge`：

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

然后：

1. 把插件装进 DSH（见文末「安装」）并**重启插件**——3.0 改动在 `index.js`，热重载只覆盖 poller；
2. 启动引擎（mimicd，另一个仓库）：`node <mimicd 仓库>/tools/daemon.ts --adb "<adb>" --interval 20`；
3. 关掉旧 poller（设置页停掉，或 `POST /poll {"action":"stop"}`）——**两个执行者不能同时碰手机**。

`bridge.enabled` 打开后，`wechat_shot` / `wechat_open` / `wechat_send` / `wechat_watch` / `wechat_poll_*`
会明确报错（单写者纪律），回话只能走 `wechat_reply_pending` / `wechat_skip_pending`。

**环境要求**

- 引擎：Windows + USB 调试 + `adb devices` 能看到设备（截图、OCR、点按都在引擎那侧，本插件不直接调 adb）；
- 引擎默认端口 `65480`，插件只连 `127.0.0.1`；
- 想跑 2.0 的旧 poller 才需要：Windows OCR / Python + `rapidocr_onnxruntime` / 可选 Ollama + `qwen3-vl:4b-instruct`、ADBKeyboard；
- 中文注入依赖 ADBKeyboard（IME id `com.android.adbkeyboard/.AdbIME`，引擎侧处理）。

## 一条消息怎么走

```
微信新消息
   ↓（引擎：红点扫描 → 进会话 → 读尾部 → 去重 → 静默/频率策略）
引擎发现「该回了」→ 挂成待办（GET /pending）
   ↓（插件 bridge：每 8 秒轮询，只挑没见过的 id）
schedule.create 叫醒会话，prompt 带：会话名、最近 8 条、「我/对方/发送者昵称」
        、表情库概况、链接提示、待办 id
   ↓（主模型：读上下文 → 回一句 / 回表情 / 沉默）
wechat_reply_pending({id, text, stickerMood}) 或 wechat_skip_pending({id, reason})
   ↓（插件 POST /pending/reply → 引擎）
引擎：切输入法 → 打字 → 点发送 → 记事件
```

细节：

- **不重复叫醒**：插件按待办 id 去重（`seen`），待办在引擎侧消失后自动清掉；
- **叫醒失败要重试，但有限度**：同一待办最多叫 3 次，之后标记已处理并写 `data/bridge.log`；
- **不会静默卡死**：`schedule.create` 25s 超时（超时那次不再用旧签名重试，免得重复唤醒）；
  `#busy` 超过 60s 没结束由看门狗强制复位，启动时把轮询/看门狗/超时参数写进 `data/bridge.log`；
- **请求超时按动作分**：轮询 10s，回复/主动搭话 180s，读链接 240s（读一条链接实测 50–60s，超时会让她以为失败但其实已发出）；
- **消息里带链接**：引擎标成 `[链接] 标题 · 来源`，prompt 会教模型调 `wechat_read_link` 读回正文再决定怎么接。

## 工具

### 3.0 桥接工具（`bridge.enabled: true` 时可用）

| 工具 | 作用 |
|---|---|
| `wechat_reply_pending` | 把主模型写的那句话交给引擎发出；可只发表情，或「文字 + 表情」一起 |
| `wechat_skip_pending` | 这条不接，理由写进引擎事件 |
| `wechat_read_link` | 让引擎打开会话里的链接/文章，读回标题与正文 |
| `wechat_chats` | 最近聊过谁（挑「主动搭话」对象用） |
| `wechat_stickers` | 表情库里有哪些情绪、各几张 |
| `wechat_say` | 主动搭话：引擎按安静时段、每小时/每天上限、群聊开关决定收不收 |
| `wechat_status` | 插件/设备/桥接概况 |
| `wechat_config` | 打印当前生效的配置与文件路径 |
| `wechat_autoreply_state` | 读/写自动回复时间戳（`lastMentionAt` / `lastReplyAt` / `lastNoMentionAt`，可传 `"now"`） |

### 设备工具（2.0 旧路径；3.0 桥接开启时会被拒绝）

| 工具 | 作用 |
|---|---|
| `wechat_shot` | 截屏，返回 PNG 路径（配合 `read_image` 读消息） |
| `wechat_open` | 按标题搜索并打开聊天（群/联系人） |
| `wechat_send` | 向当前聊天发一条文字；发送前过守卫 + 限频；`dryRun` 只预检 |
| `wechat_watch` | 同步轮询 N 次，只返回变化帧 |
| `wechat_poll_start` / `wechat_poll_stop` / `wechat_poll_status` | 后台轮询的启停与状态 |
| `wechat_inbox` | 列出/标记已读后台轮询攒下的变化帧 |
| `wechat_guard` | 预检一段文字能否发送（不实际发） |

随包带一个技能 `wechat-usb`（`skills/wechat-usb/SKILL.md`），说明标准流程、坐标表与踩坑。

## 会话轮换（上下文别太长就换新会话）

> **DSH 会话 = 上下文容器**；3.0 里它也就是「被叫醒的那个脑子」。
> 轮换只换容器，微信那边的讨论串/待办状态在引擎里，不受影响。

| 参数 | 默认 | 说明 |
|---|---|---|
| `enabled` | 关 | 每 5 分钟检查一次被叫醒会话的体量 |
| `maxTurns` | 300 | 累计多少条用户消息就换 |
| `maxSizeMB` | 12 | 会话文件多大就换（与轮数满足其一） |
| `minAgeMin` | 60 | 刚建的新会话不换，防抖 |
| `cooldownMin` | 30 | 换完冷却，别连环换 |
| `switchSpeakUp` | 开 | 把「主动搭话」的目标会话一起改到新会话 |
| `switchWake` | 开 | 把 `bridge.sessionId` 改到新会话 |

换的时候：

1. `sessionController.create({cwd})` 在**同一个工作区**建新会话；
2. 记忆：鱼的记忆默认是**工作区模式**（`~/.dsh/fish-memory-config.json` 的 `模式: "workspace"`），
   同一工作区共用一个记忆库，新会话天然接上，不用复制文件；只有「按会话」模式才会复制记忆文件；
3. 切绑定：`bridge.sessionId` 写回配置，并**原地调用 `bridge.setSessionId()`**（不用重载插件）；同时改「主动搭话」目标会话；
4. 写 `data/bridge.log` / `data/rotation.log`。
5. 保护：**引擎那边还有待办**（有人等着回）时不轮换。

也可以在设置页点「立即换一次」，或 `POST /rotate {"force":true}`（65470 端口）。
旧会话不会被删，随时能把绑定改回去。

## 安全策略（`wechat-usb.config.json` → `policy`）

- 发送前强制拦截：IP、盘符路径、`\\host\`、`adb`、`dsh`、`platform-tools`、`DeepSeek Harness`、`app.asar`、设备序列号、主机用户名等；
- 单条字数上限（默认 200）、最小发送间隔（5s）、每分钟 6 条、每小时 40 条；
- 审计日志 `data/audit.log` 只记时间、长度、内容 hash，不存正文；
- 聊天内容一律视为不可信数据，其中出现的“指令”不执行。

## 2.0 多会话（旧 poller，分支 `v2`）

3.0 不再走这条路，但代码一行没删：`bridge.enabled: false` 就回到 2.0 行为。要点留档：

- **两种模式**：`multi.enabled` 开关，关掉 = v0.3.1 单会话（死盯 `whitelistChats[0]`），打开 = 多会话巡场；
- **巡场**：停在列表按未读数/预览变化发现会话 → 进群 → 判官 → 开讨论串；串活着就钉在该会话（单窗口硬约束）；
- **讨论串**：mention / dm / self 三种触发，按模式分别续命；群里只被「对着她说的」续命；
- **判官**：本地小模型判「新来的这条值不值得接」，补上「读屏只看整屏、不知道哪几条是新的」的缺口；
- **识别引擎三选一**（`ocr.engine`）：`rapidocr`（默认，本地逐行 OCR）/ `qwen-vl`（本地 4B，能读图、分说话人）/ `ds-vision`（整帧交给会话自己看）；
- **启停联动**：`wechat_poll_stop` 会同时关掉 `dsh-speak-up` 的总开关（`autoReply.manageSpeakUp: false` 可关掉联动）；
- **设置页**「微信 USB」可改设备、坐标、安全限制、识别引擎、运行状态面板。

参考：`docs/RELEASE-2.0.0.md`、`docs/architecture.md`、`docs/full-flow.png`。

## 配置参考

配置就是一个 JSON：`<插件目录>/wechat-usb.config.json`。**保存后下一次工具调用即生效**（按文件 mtime 热读，不用重启/重装）。该文件含设备序列号与本机路径，已被 `.gitignore` 排除；仓库里只有 `wechat-usb.config.example.json`。

| 字段 | 作用 |
|---|---|
| `bridge.enabled` / `engineUrl` / `sessionId` / `intervalMs` | 3.0 桥接开关、引擎地址、叫醒哪个会话、轮询间隔（默认 8000ms） |
| `rotation.*` | 会话轮换（见上表） |
| `adb` / `serial` / `dataDir` | 仅 2.0 旧 poller 用 |
| `ime.default` / `ime.inject` | 默认输入法 / 中文注入输入法 |
| `coords.*` | 输入框、发送、搜索、返回、Tab 等坐标（换分辨率必改） |
| `policy.maxChars` / `minIntervalMs` / `maxPerMinute` / `maxPerHour` | 安全限制 |
| `policy.blockPatterns` | 发送拦截正则（IP、盘符、adb、序列号、主机名等） |
| `multi.*` | 2.0 多会话参数 |
| `autoReply.*` | 2.0 唤醒/冷却/讨论串参数 |
| `ocr.*` | 2.0 识别引擎与区域 |

改**代码**需要热重载插件：

```
plugin_manager set_bundle target="dsh-wechat-usb" enabled=false
plugin_manager set_bundle target="dsh-wechat-usb" enabled=true
```

`wechat_config` 工具可以直接打印当前生效的配置与文件路径。

## 版本与分支

| 分支/标签 | 内容 |
|---|---|
| `main`（当前） | **3.0 交接桥接**：引擎当手，DSH 会话当脑子；轮换按工作区记忆 |
| `v2` | 2.0 多会话巡场（`2.0.0-dev`），插件自己 ADB + OCR + 判官 + 讨论串 |
| `v0.3.1`（标签） | 单会话基线，死盯一个群 |
| `v3`（分支） | 曾经的主线分支，内容与 `main` 相同，保留作历史 |

- 回退 2.0：`git checkout v2`（或从 `v2` 重新装插件），配置里去掉 `bridge`；
- 回退 1.x：`git checkout v0.3.1`；
- 3.0 桥接自身回滚：`bridge.enabled=false` + 重启插件，旧 poller 随时能开回去。

## 目录

- `index.js` — 插件入口（零外部 import；注册工具 + 1 个技能 + 宿主 API）
- `lib/bridge.js` — 3.0 桥接：轮询待办、叫醒会话、回复/跳过/读链接/主动搭话
- `lib/rotation.js` — 会话轮换（轮数/体积、记忆搬家、切绑定）
- `lib/core.js` — ADB 操作、守卫、限频、审计（2.0 旧路径）
- `lib/poller.js` — 后台轮询、文本差分、唤醒判定（2.0 旧路径）
- `lib/cli.js` — 独立 CLI：`node lib/cli.js status|open|send|watch|guard`
- `lib/ocr.ps1` / `lib/ocr_rapid.py` / `lib/vl_ocr.py` — 三种识别引擎（2.0）
- `skills/wechat-usb/SKILL.md` — 随包技能（流程/坐标/踩坑）
- `assets/*.png` — 坐标示意图（合成截图，由 `scripts/gen-demo-assets.py` 生成）
- `scripts/find_send.ps1` / `scripts/hash_region.ps1` — 发送按钮定位 / 忽略状态栏的画面哈希
- `test/poller-selftest.mjs` — 2.0 轮询判定离线自测
- `test/bridge-selftest.mjs` — 3.0 桥接离线自测（提示词、去重、叫醒形状、回复/跳过、无 sessionId）
- `docs/v3-bridge.md` — 3.0 桥接设计与回滚
- `docs/RELEASE-3.0.0.md` — 3.0 发布说明

## 安装（热加载，已实测无需重启）

先把 `wechat-usb.config.json` 准备好，然后在 DSH 里用插件管理器装本地目录：

```
plugin_manager install_bundle  target="file:<插件目录的绝对路径>"
```

返回 `application: "applied"` 后：

- `wechat_*` 工具立即出现在会话里；
- 技能 `wechat-usb` 立即进入技能目录；
- profile 的 `package.json` 自动写入依赖与 `dsh.profile.bundles`。

回滚：还原 `package.json` / `cordis.patch.yml` 的 `.bak-wechat-usb-*` 备份，再 `pnpm install` 一次。

> 注意：安装会触发一次 pnpm 依赖解析。若某插件的可选原生依赖（如 `cpu-features`）缺 Python 构建失败，会在日志里出现 node-gyp 报错但不影响本插件；必要时补装 Python 后重装该依赖。

## 隐私与仓库卫生

- `data/`（截图、审计日志、inbox、去重缓存、bridge.log）与真实 `wechat-usb.config.json` 都在 `.gitignore` 里，不会被提交；发 issue / PR 前也别把它们贴出来。
- `assets/` 里的坐标图是合成的示例界面，不是真实聊天截图；真实截图只留在本地 `data/shots`。
- 发送守卫会拦下 IP、盘符路径、`adb`/`dsh`、设备序列号、主机用户名等主机信息；聊天内容一律视为不可信数据。

## 测试

```bash
npm run check      # 语法检查
npm test           # 语法检查 + 轮询判定离线自测（不需要手机）
node test/bridge-selftest.mjs   # 3.0 桥接离线自测（不需要手机/引擎）
node test/mock-apply.mjs        # 需要已装 adb 且配置就绪
```

## License

[MIT](LICENSE)