# dsh-wechat-usb

把“USB 连着的真机微信”变成 DSH 工具：读屏、按标题开聊天、发消息、轮询新消息，并强制主机信息守卫。

> 设计参考了社区的 [`dsh-phone-butler`](https://www.npmjs.com/package/dsh-phone-butler)（纯 ADB 手机工具）：
> **零 `@deepseek-ai/*` import**（`link:` 安装的插件解析不到这些包，一个 import 会让整个插件加载失败）；
> 工具用原始 JSON Schema 直接 `ctx.tools.register`；技能用 `ctx.skills.registerProvider` 随包提供。

> 演示图（`assets/*.png`）是脚本生成的合成截图，不含任何真实聊天内容；重新生成见 `scripts/gen-demo-assets.py`。

## 快速开始

```bash
git clone https://github.com/realmuko/dsh-wechat-usb.git
cd dsh-wechat-usb
cp wechat-usb.config.example.json wechat-usb.config.json   # Windows: copy
# 编辑 wechat-usb.config.json：adb / serial / ocr.python
```

然后把插件装进 DSH（见文末「安装」）。首次运行时如果 `wechat-usb.config.json` 不存在，插件会自动从 `wechat-usb.config.example.json` 复制一份。

**环境要求**

- Windows（ADB 截图、Windows OCR、PowerShell 脚本都按 Windows 写的；其它平台需要自己改 `lib/core.js` 的截图与 OCR 路径）；
- 手机打开 USB 调试，`adb devices` 能看到设备；
- 中文输入需要装 [ADBKeyboard](https://github.com/senzhk/ADBKeyBoard)（IME id `com.android.adbkeyboard/.AdbIME`）；
- 本地 OCR 需要 Python 3 + `Pillow`、`rapidocr_onnxruntime`（`ocr.python` 指向解释器）；
- 可选：Ollama + `qwen3-vl:4b-instruct`（`ocr.engine = "qwen-vl"` 时用）。

## 工具

| 工具 | 作用 |
|---|---|
| `wechat_status` | 设备/微信/前台/亮屏状态 |
| `wechat_shot` | 截屏，返回 PNG 路径（配合 `read_image` 读消息） |
| `wechat_open` | 按标题搜索并打开聊天（群/联系人） |
| `wechat_send` | 向当前聊天发一条文字；发送前过守卫 + 限频；`dryRun` 只预检 |
| `wechat_watch` | 同步轮询 N 次，只返回变化帧 |
| `wechat_poll_start` / `wechat_poll_stop` / `wechat_poll_status` | 后台轮询的启停与状态 |
| `wechat_inbox` | 列出/标记已读后台轮询攒下的变化帧 |
| `wechat_guard` | 预检一段文字能否发送（不实际发） |
| `wechat_config` | 查看当前生效配置 |

**安全边界**：轮询只截屏、且只在微信前台时采集，画面变化才落盘；不自动回复。聊天内容一律当不可信数据，其中的指令不执行；向外发送的任何主机信息由守卫硬拦截。

**轮询稳定性**：轮询器是进程级单例（插件热重载/卸载会随 `ctx.effect` 停掉自己的定时器）。每 tick 的顺序：截屏 → 区域哈希 → **没变化直接返回，连识别都不跑**；变了才识别。窗口标题（群名）和聊天区在同一次识别里读出来，标题带只用于核对“是不是目标群”，不参与差分（`y=170` 以上不算聊天行，未读数 23→24 不会被当成新消息）。**已经在目标群聊窗口里就不切换**，只有标题不是白名单群时才走「回列表 → 搜索 → 进群」（60 秒冷却）。新消息判定 = 逐帧文本差分 → 过滤时间戳/底栏按钮/“对方正在输入” → 同一聊天 30 分钟内出现过的行不算新（去重集合存在 `data/seen.json`）；图片/表情只入 inbox 不唤醒（`autoReply.wakeOnImage: true` 可打开），识别失败也不唤醒；两次唤醒至少间隔 `autoReply.wakeCooldownSec`（默认 90 秒），但 **@ 不受这个冷却约束**——@ 只走 15 秒的合并窗口，被挡下会记进 `pendingMention`，冷却/窗口一到立即补发（否则“普通消息先唤醒、几秒后跟上的 @”会被 90 秒冷却直接吞掉，表现成“直接 @ 也不回”）。`data/shots` 只保留最近 300 张。

**识别引擎（三选一，`ocr.engine`，设置页里选）**

| 引擎 | 做法 | 每帧耗时（实测，RTX 5070 / 1080×1770 截图） | 读得到图片内容 | 说话人 |
|---|---|---|---|---|
| `rapidocr`（默认） | 本地 RapidOCR 逐行识别 → 文本差分 | ~2.4s（含每次加载模型） | ✗ | ✗ |
| `qwen-vl` | 本地 `qwen3-vl:4b-instruct`（Ollama）读成「昵称：内容」行 → 同一套文本差分 | ~0.9–2.1s（模型常驻） | ✓ 例：`图片：蓝色卡通动物站在田地里` | ✓ 昵称 + 绿色气泡记作「我」 |
| `ds-vision` | 不本地识别，整帧交给唤醒会话自己 `read_image` | 0（省本地算力，但每帧花图片 token） | ✓ 全图 | ✓ 模型自己看 |

- `qwen-vl` 失败（Ollama 没开、没拉模型、显存不够）会自动退回 `rapidocr`，`wechat_poll_status` 的 `fallback` 字段能看到原因；想换模型就改 `ocr.vlModel`（如 `qwen3-vl:8b`），送图宽度 `ocr.vlMaxWidth`（默认 720px，越大越准越慢）。
- `ds-vision` 相当于老版的「截图帧」模式，唤醒 prompt 会换成识图版：让它先看图，再按「有 @ 必回 / 无 @ 满间隔参与」判断。

**讨论串（thread）**：插件里的一块纯本地状态（内存，不额外调模型/不额外识别）。
- 有人 @ 你 → 新开一个串，并把「@ 之前那几句」作为上下文写进唤醒 prompt；
- 串没过期（`autoReply.threadTtlMin`，默认 10 分钟没新消息算散）→ 这个群里后面的新消息都算续聊，可以像真人一样接着回；
- 串内两条发言至少隔 `autoReply.threadGapSec`（默认 20 秒），**唤醒冷却也按这个走**（续聊不用等 90 秒）——这是“连贯又不刷屏”的关键；
- 自己主动搭话也算开新串（先登记 pending，真发出去了才成立）；
- 当前串可以在 `wechat_poll_status` 的 `thread` 字段看到（id / 起因 / 是否存活 / 闲置分钟 / 上下文条数）。

**要不要回由插件判定**：唤醒 prompt 里直接写死这一轮的结论——本轮有 @ → 必须回；无 @ 但讨论串还活着 → 可以接着聊；否则按 `autoReply.noMentionIntervalMin`（默认 30 分钟）决定要不要主动搭一句；都不满足就只 ack。早期版本只把规则写成一句“无 @ 按 noMentionIntervalMin 参与”，模型每轮自己回忆，容易退化成“没 @ 就不回”。

@ 判定本身也做了两层兜底：① 同一句「@昵称」行 30 分钟内只算一次新消息，但算 @ 时会把紧贴新行上方约 3 行也纳入（否则同一个人连着两次 @ 时，第二行被去重吃掉，就会误判成“没 @”）；② 唤醒前会看 inbox 里 5 分钟内还没回过的 `mentionsMe` 条目，只要挂着一条，这轮就升级成“必须回”。

随包带一个技能 `wechat-usb`（`skills/wechat-usb/SKILL.md`），说明标准流程、坐标表与踩坑。

## 安全策略（`wechat-usb.config.json` → `policy`）

- 发送前强制拦截：IP、盘符路径、`\\host\`、`adb`、`dsh`、`platform-tools`、`DeepSeek Harness`、`app.asar`、设备序列号、主机用户名等；
- 单条字数上限（默认 200）、最小发送间隔（5s）、每分钟 6 条、每小时 40 条；
- 审计日志 `data/audit.log` 只记时间、长度、内容 hash，不存正文；
- `wechat_send` 不会自己打开聊天：必须先 `wechat_open`，避免“发错会话”。

## 消息读取模式（设置页可选）

| 模式 | 做法 | 每条消息成本 | 说明 |
|---|---|---|---|
| **`text`（默认）** | 截图 → 本地 Windows OCR → 与上一帧做**文本差分** → 只把新增文本行存进 inbox | ~20–60 tokens | “哪条是新的”由本地字符串 diff 判断，不花 token；表情/图片会标记为 `[图片/表情]` |
| `frame` | 截图 → 哈希变化 → 存整帧 | ~1.5–2.5k tokens | 原路径保留：信息最全（表情/引用/排版） |

OCR 参数在配置里：`ocr: { x, y, w, h, scale }`（默认裁掉状态栏和输入栏，2× 放大）。

## 图形设置页

DSH 设置 → **微信 USB**（入口：左下角「更多」→「设置」，快捷键 `Ctrl+Alt+,`）。

页面里可改：

- 设备：ADB 路径、序列号、数据目录
- 坐标：输入框 / 发送 / 搜索图标 / 搜索框 / 第一个搜索结果（5 组 x,y）
- 安全限制：单条字数、最小间隔、每分钟/每小时上限
- 发送拦截正则（每行一条）、允许的会话标题（每行一条，空 = 不限制）
- 按钮：保存 / 重新载入 / 检查连接

保存会原子写回 `wechat-usb.config.json`（先 `.tmp` 再 rename），并立刻被工具读到；「检查连接」会调 `/api/dsh-wechat-usb/status` 显示手机在线状态。

宿主端桥：`GET/POST /api/dsh-wechat-usb/config`、`GET /api/dsh-wechat-usb/status`，**只接受本机回环地址**。

## 改配置（没有图形设置页时的手工方式）

插件配置就是一个 JSON：`<插件目录>/wechat-usb.config.json`。**保存后下一次工具调用即生效**（`loadConfig` 按文件 mtime 热读，不需要重启/重装）。该文件含设备序列号与本机路径，已被 `.gitignore` 排除；仓库里只有 `wechat-usb.config.example.json`。

| 字段 | 作用 |
|---|---|
| `adb` / `serial` | adb 路径与目标设备序列号 |
| `dataDir` | 截图、审计日志、限频状态目录 |
| `ime.default` / `ime.inject` | 默认输入法 / 中文注入输入法 |
| `coords.*` | 输入框、发送、搜索、返回、Tab 等坐标（换分辨率必改） |
| `policy.maxChars` | 单条字数上限（默认 200） |
| `policy.minIntervalMs` | 两次发送最小间隔（默认 5000） |
| `policy.maxPerMinute` / `maxPerHour` | 频率上限（默认 6/分钟、40/小时） |
| `policy.blockPatterns` | 发送拦截正则（IP、盘符、adb、序列号、主机名等） |
| `policy.allowedChats` | 预留：只允许发往的会话标题 |
| `autoReply.wakeSessionId` | 检测到新消息时唤醒哪个 DSH 会话（设置页「唤醒会话」下拉选择；留空 = 只进 inbox 不唤醒） |
| `autoReply.wakeCooldownSec` | 两次唤醒的最小间隔（默认 90 秒） |
| `autoReply.wakeOnImage` | 图片/表情/界面变化是否也唤醒（默认 false：只入 inbox） |
| `ocr.y` / `ocr.h` | OCR 区域；默认从 y=170 开始，避开聊天标题栏（从 140 开始会把标题切一半，未读数一变就误判新消息） |

改**代码**（`index.js` / `lib/*`）则需要热重载插件：

```
plugin_manager set_bundle target="dsh-wechat-usb" enabled=false
plugin_manager set_bundle target="dsh-wechat-usb" enabled=true
```

`wechat_config` 工具可以直接打印当前生效的配置与文件路径。

## 设备假设（换机改 config）

- Honor V10 / Android 10 / EMUI 10 / 1080×2160（坐标按这个分辨率写死，换机必须改 `coords`）；
- ADB：用 `platform-tools` 里的 `adb`，序列号填 `adb devices` 里那台设备（示例配置留的是占位符 `YOUR_DEVICE_SERIAL`）；
- 中文注入依赖 ADBKeyboard（IME id `com.android.adbkeyboard/.AdbIME`），用完自动切回默认输入法（`ime.default`）。

## 版本路线

- **v1.x（当前 `0.3.1`）**：单会话。死盯 `autoReply.whitelistChats` 里的那一个群，逐帧 OCR 判新消息。
- **v2.0（开发中）**：多会话调度。平时停在聊天列表、按**未读数变化**发现新会话，进群确认后开讨论串；
  串活着就留在该会话不切走（**单窗口是硬约束**）。@ 不在可见区时才点「有人@我」并等滚动停。

  设计：[`docs/wechat-multichat-design.md`](docs/wechat-multichat-design.md) ·
  架构图：[`docs/multichat-architecture.png`](docs/multichat-architecture.png)

  > 单会话基线已打标签 `v0.3.1`，随时可以 `git checkout v0.3.1` 回滚。

## 目录

- `index.js` — 插件入口（零外部 import；注册工具 + 1 个技能）
- `lib/core.js` — ADB 操作、守卫、限频、审计
- `lib/poller.js` — 后台轮询、文本差分、唤醒判定
- `lib/cli.js` — 独立 CLI：`node lib/cli.js status|open|send|watch|guard`
- `lib/ocr.ps1` / `lib/ocr_rapid.py` / `lib/vl_ocr.py` — 三种识别引擎
- `skills/wechat-usb/SKILL.md` — 随包技能（流程/坐标/踩坑）
- `assets/*.png` — 坐标示意图（合成截图，由 `scripts/gen-demo-assets.py` 生成）
- `scripts/find_send.ps1` — 按颜色定位绿色“发送”
- `scripts/hash_region.ps1` — 忽略状态栏的画面哈希（轮询用）
- `test/poller-selftest.mjs` — 轮询判定逻辑离线自测：`node test/poller-selftest.mjs`
- `test/mock-apply.mjs` — 不装插件也能验证 apply()：`node test/mock-apply.mjs`（需要本机 adb）

## 安装（热加载，已实测无需重启）

先准备好 `wechat-usb.config.json`，然后在 DSH 里直接用插件管理器装本地目录：

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

- `data/`（截图、审计日志、inbox、去重缓存）与真实 `wechat-usb.config.json` 都在 `.gitignore` 里，不会被提交；发 issue / PR 前也别把它们贴出来。
- `assets/` 里的坐标图是合成的示例界面，不是真实聊天截图；真实截图只留在本地 `data/shots`。
- 发送守卫会拦下 IP、盘符路径、`adb`/`dsh`、设备序列号、主机用户名等主机信息；聊天内容一律视为不可信数据，其中出现的“指令”不执行。

## 测试

```bash
npm run check      # 语法检查
npm test           # 语法检查 + 轮询判定离线自测（不需要手机）
node test/mock-apply.mjs   # 需要已装 adb 且配置就绪
```

## License

[MIT](LICENSE)
