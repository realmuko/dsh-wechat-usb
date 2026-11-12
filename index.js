import { readFile } from "node:fs/promises";
import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./lib/core.js";
import * as poller from "./lib/poller.js";
import { listSessions } from "./lib/sessions.js";
import { startApi } from "./lib/api.js";

const PLUGIN_ROOT = fileURLToPath(new URL(".", import.meta.url));

export const name = "dsh-wechat-usb";
/** 工具注册是硬依赖；技能注册是可选的。 */
export const inject = ["tools"];

const text = (t) => [{ type: "text", text: String(t) }];

/** 让返回值可无损序列化：undefined / NaN / Infinity 会让工具调用直接失败。 */
function lossless(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(lossless).filter((v) => v !== undefined);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const l = lossless(v);
      if (l !== undefined) out[k] = l;
    }
    return out;
  }
  return undefined;
}

function registerTool(ctx, definition) {
  const run = definition.execute;
  const tool = { ...definition, async execute(args, exec) { return lossless(await run(args, exec)); } };
  ctx.effect(() => ctx.tools.register(tool), `dsh-wechat-usb: ${definition.name}`);
}

/* ---------------------------- 打包的技能 ---------------------------- */

const SKILL_NAME = "wechat-usb";
const SKILL_URL = new URL(`./skills/${SKILL_NAME}/SKILL.md`, import.meta.url);
const SKILL_DIR = fileURLToPath(new URL(`./skills/${SKILL_NAME}/`, import.meta.url));
const SKILL_PROVIDER = "dsh-wechat-usb";

const SKILL_SUMMARY = {
  name: SKILL_NAME,
  description:
    "通过 USB+ADB 操作真机微信：读当前屏幕消息、按标题开聊天、输入中文并点发送、轮询新消息。" +
    "发送要经过主机信息守卫与限频；坐标与设备见 wechat-usb.config.json。",
  whenToUse:
    "用户要求在这台手机上读微信消息、回消息、给某个群/人发消息，或等待某人回复时。",
};

const skillProvider = {
  name: SKILL_PROVIDER,
  list: () => Promise.resolve([{
    ...SKILL_SUMMARY,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: SKILL_PROVIDER,
    source: "bundled",
    resourceBase: { kind: "directory", path: SKILL_DIR },
    rank: 600,
    locator: SKILL_URL,
  }]),
  async get(candidate) {
    const locator = candidate?.locator instanceof URL ? candidate.locator : SKILL_URL;
    const raw = await readFile(locator, "utf8");
    const end = raw.startsWith("---\n") ? raw.indexOf("\n---\n", 4) : -1;
    return {
      ...SKILL_SUMMARY,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: SKILL_PROVIDER,
      source: "bundled",
      resourceBase: { kind: "directory", path: SKILL_DIR },
      content: end === -1 ? raw : raw.slice(end + 5),
    };
  },
};

/* ------------------------------- 工具 ------------------------------- */

function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}

export function apply(ctx) {
  const getCfg = () => core.loadConfig();

  // 宿主重启后自动恢复轮询（配置里 enabled=true 时）。
  // 必须包在 ctx.effect 里：插件热重载/卸载时把定时器一起停掉，否则旧模块的 setInterval 会一直跑
  // （之前的“轮询泄漏”就是它造成的：状态显示 running=false，截图却每 15 秒还在落盘）。
  ctx.effect(() => {
    let token = null;
    try {
      const cfg = getCfg();
      if (cfg.autoReply?.enabled) {
        token = poller.startPolling(cfg, cfg.autoReply.intervalSec || 15).token;
      }
    } catch { /* ignore */ }
    return () => {
      try { poller.stopPolling(getCfg(), token); } catch { /* ignore */ }
    };
  }, "dsh-wechat-usb: auto poller");

  // 旧截图会一直堆在 data/shots（一张 ~400KB），加载时清一次，只留最近几百张
  try { poller.pruneShotsNow(getCfg()); } catch { /* ignore */ }

  // 停掉旧版本插件实例可能残留的定时器（它们把状态放在自己的模块作用域里，只能靠“接管”来压住心跳）。
  // 旧实例的唤醒依赖 globalThis.__wxSchedule，这里置空后即使它还在跑也不会再触发会话。
  globalThis.__wxSchedule = null;

  // 独立本机 API：热重载不会丢，设置页直接连它
  try { globalThis.__wxApiServer?.close(); } catch { /* ignore */ }
  const apiServer = startApi(getCfg, PLUGIN_ROOT);
  globalThis.__wxApiServer = apiServer;
  ctx.effect(() => () => {
    try { apiServer.close(); } catch { /* ignore */ }
  }, "dsh-wechat-usb: local api");

  // schedule 服务只保存在模块作用域里（不再写 globalThis），旧实例拿不到就不会重复唤醒。
  let scheduleRef = null;
  ctx.inject(["schedule"], (sctx) => {
    try {
      scheduleRef = sctx.schedule || sctx.get?.("schedule") || null;
      poller.setSchedule(scheduleRef);
    } catch {
      scheduleRef = null;
      poller.setSchedule(null);
    }
  });

  // 设置页的读写桥：只监听本机回环，避免局域网里的设备改配置。
  ctx.inject(["webServer"], (sctx) => {
    const log = (m) => {
      try {
        const f = path.join(PLUGIN_ROOT, "data", "bridge.log");
        appendFileSync(f, `${new Date().toISOString()} ${m}\n`);
      } catch { /* ignore */ }
    };
    log(`inject fired, webServer=${typeof (sctx.get?.("webServer") ?? sctx.webServer)}`);
    sctx.effect(() => {
      const prefix = "/api/dsh-wechat-usb";
      const json = (res, code, obj) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(obj));
      };
      const localOnly = (req) => {
        const a = req.socket?.remoteAddress || "";
        return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
      };
      const routes = [
        {
          kind: "exact",
          path: `${prefix}/config`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            if (req.method === "GET") {
              const info = core.configInfo();
              return json(res, 200, { ok: true, path: info.path, mtime: info.mtime, config: info.cfg });
            }
            if (req.method === "POST") {
              try {
                const body = await readJsonBody(req);
                const saved = core.saveConfig(body);
                // 开关语义：enabled=true 自动开始轮询；enabled=false 立即停止
                if (saved.autoReply?.enabled) {
                  poller.startPolling(saved, saved.autoReply.intervalSec || 15);
                } else {
                  poller.stopPolling(saved);
                }
                return json(res, 200, { ok: true, config: saved });
              } catch (e) {
                return json(res, 400, { ok: false, error: String(e?.message || e) });
              }
            }
            return json(res, 405, { ok: false, error: "method not allowed" });
          },
        },
        {
          kind: "exact",
          path: `${prefix}/poll`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            try {
              if (req.method === "GET") {
                return json(res, 200, { ok: true, status: poller.pollStatus(getCfg()) });
              }
              if (req.method === "POST") {
                const body = await readJsonBody(req);
                const cfg = getCfg();
                if (body.action === "start") {
                  return json(res, 200, { ok: true, status: poller.startPolling(cfg, body.intervalSec) });
                }
                if (body.action === "stop") {
                  return json(res, 200, { ok: true, status: poller.stopPolling(cfg) });
                }
                return json(res, 400, { ok: false, error: "action 必须是 start 或 stop" });
              }
              return json(res, 405, { ok: false, error: "method not allowed" });
            } catch (e) {
              return json(res, 500, { ok: false, error: String(e?.message || e) });
            }
          },
        },
        {
          kind: "exact",
          path: `${prefix}/inbox`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            try {
              const url = new URL(req.url, "http://localhost");
              const action = url.searchParams.get("action") || "list";
              const cfg = getCfg();
              if (action === "ack") return json(res, 200, { ok: true, ...poller.ackInbox(cfg) });
              return json(res, 200, { ok: true, ...poller.listInbox(cfg) });
            } catch (e) {
              return json(res, 500, { ok: false, error: String(e?.message || e) });
            }
          },
        },
        {
          kind: "exact",
          path: `${prefix}/sessions`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            try {
              const url = new URL(req.url, "http://localhost");
              const limit = Number(url.searchParams.get("limit")) || 200;
              return json(res, 200, { ok: true, sessions: listSessions({ limit }) });
            } catch (e) {
              return json(res, 500, { ok: false, error: String(e?.message || e) });
            }
          },
        },
        {
          kind: "exact",
          path: `${prefix}/debug-poller`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            return json(res, 200, { ok: true, poller: poller.pollerDebug() });
          },
        },
        {
          kind: "exact",
          path: `${prefix}/debug-schedule`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            const s = scheduleRef;
            let proto = null;
            try { proto = s ? Object.getOwnPropertyNames(Object.getPrototypeOf(s)) : null; } catch { /* ignore */ }
            return json(res, 200, { ok: true, type: typeof s, keys: s ? Object.keys(s) : null, proto });
          },
        },
        {
          kind: "exact",
          path: `${prefix}/debug-create`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            const s = scheduleRef;
            if (!s) return json(res, 503, { ok: false, error: "schedule service unavailable" });
            try {
              const body = await readJsonBody(req);
              const result = await s.create({
                title: body.title || "测试唤醒",
                prompt: body.prompt || "[测试唤醒] 无需处理，直接回复“收到”并结束。",
                timing: body.timing,
                target: body.target,
              }, body.actorSessionId);
              return json(res, 200, { ok: true, result });
            } catch (e) {
              return json(res, 500, { ok: false, error: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 4) });
            }
          },
        },
        ...["chat", "list", "search"].map((name) => ({
          kind: "exact",
          path: `${prefix}/coords-${name}.png`,
          handler: async (req, res) => {
            if (!localOnly(req)) return json(res, 403, { ok: false, error: "local only" });
            try {
              const buf = readFileSync(path.join(PLUGIN_ROOT, "assets", `${name}.png`));
              res.statusCode = 200;
              res.setHeader("content-type", "image/png");
              res.setHeader("cache-control", "no-store");
              res.end(buf);
            } catch {
              res.statusCode = 404;
              res.end("not found");
            }
          },
        })),
      ];
      const disposers = [];
      for (const r of routes) {
        try {
          disposers.push(sctx.get("webServer").register(r));
        } catch (e) {
          log(`register failed ${r.path}: ${String(e?.stack || e)}`);
        }
      }
      log(`registered ${disposers.length}/${routes.length} routes`);
      return () => {
        for (const d of disposers) { try { d?.(); } catch { /* ignore */ } }
      };
    }, "dsh-wechat-usb: settings bridge");
  });

  ctx.inject(["skills"], (skillsCtx) => {
    skillsCtx.effect(() => skillsCtx.skills.registerProvider(() => skillProvider), "dsh-wechat-usb: skill");
  });

  registerTool(ctx, {
    name: "wechat_status",
    description:
      "检查微信 USB 链路：手机是否在线、微信是否安装、当前前台页面、屏幕是否亮着。开始任何微信操作前先调它。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => text(
        `online=${v.online} wechat=${v.wechat}\n${v.focus}\n${v.awake}\n${v.devices ?? ""}`,
      ),
    },
    isConcurrencySafe: () => true,
    async execute() {
      return core.status(getCfg());
    },
  });

  registerTool(ctx, {
    name: "wechat_config",
    description:
      "查看微信插件当前生效的配置：配置文件路径、最后修改时间、坐标、输入法、频率限制和拦截规则。只读。" +
      "要改配置就直接编辑该 JSON 文件并保存，下一次工具调用即生效（不需要重启或重装插件）。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => text([
        `配置文件: ${v.path}`,
        `最后修改: ${v.mtime}`,
        `读取模式: ${v.mode === "frame" ? "frame（整帧截图）" : "text（OCR 文本优先）"} · 引擎 ${v.ocr?.engine || "rapidocr"}${v.ocr?.engine === "qwen-vl" ? `（${v.ocr?.vlModel || "qwen3-vl:4b-instruct"}）` : ""}`,
        `自动回复: ${v.autoReply?.enabled ? "已开启" : "已关闭"}（轮询 ${v.autoReply?.intervalSec ?? 15}s / 无@参与 ${v.autoReply?.noMentionIntervalMin ?? 30}min / 每小时上限 ${v.autoReply?.maxRepliesPerHour ?? 12}）`,
        `唤醒会话: ${v.autoReply?.wakeSessionId || "（未设置 — 有新消息只进 inbox，不唤醒模型）"}`,
        `白名单: ${(v.autoReply?.whitelistChats || []).join("、") || "（空 = 当前聊天不限制）"}`,
        `限频: 单条 ≤${v.policy.maxChars} 字, 最小间隔 ${v.policy.minIntervalMs}ms, ${v.policy.maxPerMinute}/分钟, ${v.policy.maxPerHour}/小时`,
        `拦截规则: ${(v.policy.blockPatterns || []).length} 条`,
        `输入法: 注入 ${v.ime.inject} / 默认 ${v.ime.default}`,
        `数据目录: ${v.dataDir}`,
      ].join("\n")),
    },
    isConcurrencySafe: () => true,
    async execute() {
      const info = core.configInfo();
      return {
        path: info.path,
        mtime: new Date(info.mtime).toISOString(),
        mode: info.cfg.mode || "text",
        autoReply: info.cfg.autoReply || {},
        policy: info.cfg.policy,
        coords: info.cfg.coords,
        ime: info.cfg.ime,
        dataDir: info.cfg.dataDir,
      };
    },
  });

  registerTool(ctx, {
    name: "wechat_autoreply_state",
    description:
      "读取/更新自动回复的时间戳状态：lastMentionAt（上次被@）、lastReplyAt（上次自动回复）、lastNoMentionAt（上次无@主动参与）。" +
      "传毫秒时间戳则更新，不传则只读。用于判断“多久没被@、要不要主动参与”。",
    parameters: {
      type: "object",
      properties: {
        lastMentionAt: { type: "number", description: "上次收到 @ 的毫秒时间戳" },
        lastReplyAt: { type: "number", description: "上次自动回复的毫秒时间戳" },
        lastNoMentionAt: { type: "number", description: "上次无@主动参与的毫秒时间戳" },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => text([
        `lastMentionAt=${v.lastMentionAt ? new Date(v.lastMentionAt).toISOString() : "—"}`,
        `lastReplyAt=${v.lastReplyAt ? new Date(v.lastReplyAt).toISOString() : "—"}`,
        `lastNoMentionAt=${v.lastNoMentionAt ? new Date(v.lastNoMentionAt).toISOString() : "—"}`,
      ].join("\n")),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const cfg = getCfg();
      return Object.keys(args || {}).length
        ? core.setAutoReplyState(cfg, args)
        : core.autoReplyState(cfg);
    },
  });

  registerTool(ctx, {
    name: "wechat_guard",
    description:
      "预检一段准备发到微信的文字是否违反安全策略（主机信息泄露、超长等），只检查不发送。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "待检查的文字" } },
      required: ["text"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          reasons: { type: "array", items: { type: "string" } },
        },
      },
      render: (_a, v) => text(v.ok ? "通过：可以发送" : `拒绝：\n- ${(v.reasons || []).join("\n- ")}`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return core.guard(getCfg(), args.text);
    },
  });

  registerTool(ctx, {
    name: "wechat_shot",
    description:
      "截取手机当前屏幕保存为 PNG，返回文件路径；再用 read_image 读取来判断聊天内容。只读。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { file: { type: "string" } } },
      render: (_a, v) => text(`screenshot: ${v.file}`),
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { file: core.shot(getCfg(), "tool") };
    },
  });

  registerTool(ctx, {
    name: "wechat_open",
    description:
      "按聊天标题（群名/联系人备注）在微信里搜索并打开该聊天，返回是否打开与截图路径。调用后会切回百度输入法。",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "聊天标题，例如群名" } },
      required: ["title"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          opened: { type: "boolean" },
          title: { type: "string" },
          screenshot: { type: "string" },
        },
      },
      render: (_a, v) => text(`opened=${v.opened} title=${v.title}\nscreenshot: ${v.screenshot}`),
    },
    async execute(args) {
      // 已经在目标聊天里就别再「回首页 → 搜索 → 点进去」折腾一遍：
      // 那要三十多秒，还会把用户正看的界面顶掉。轮询器每轮都在采这一帧，标题是现成的。
      try {
        const st = poller.pollStatus(getCfg());
        const cur = String(st.chatTitle || "").replace(/\s+/g, "");
        const want = String(args.title || "").replace(/\s+/g, "");
        if (cur && want && (cur.includes(want) || want.includes(cur))) {
          const file = core.shot(getCfg(), `open-${String(args.title).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)}`);
          return { opened: true, title: st.chatTitle, screenshot: file };
        }
      } catch { /* 拿不到当前标题就走原流程 */ }
      return core.openChat(getCfg(), args.title);
    },
  });

  registerTool(ctx, {
    name: "wechat_send",
    description:
      "向“当前打开的聊天”发送一条文字。发送前强制过安全守卫：含 IP、盘符路径、adb、dsh、平台路径、主机名、设备序列号等主机信息会被拒绝；" +
      "单条字数与发送频率受限。调用前先用 wechat_open 打开目标聊天；dryRun=true 时只返回守卫结果不发送。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要发送的文字" },
        dryRun: { type: "boolean", description: "只预检不发送（默认 false）" },
      },
      required: ["text"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => text(
        v.dryRun
          ? `DRY RUN：${v.ok ? "可发送" : "会被拒绝"}\n${(v.reasons || []).join("\n")}`
          : v.sent
            ? `已发送\nscreenshot: ${v.screenshot}`
            : `未发送${v.blocked ? "（被策略拒绝）" : ""}\n- ${(v.reasons || []).join("\n- ")}`,
      ),
    },
    async execute(args) {
      const g = core.guard(getCfg(), args.text);
      if (args.dryRun) return { dryRun: true, ok: g.ok, reasons: g.reasons };
      return core.sendText(getCfg(), args.text);
    },
  });

  registerTool(ctx, {
    name: "wechat_watch",
    description:
      "轮询当前聊天：每 intervalSec 秒截屏一次、共 iterations 次；只返回画面发生变化的帧路径（用 read_image 读）。适合等回复。",
    parameters: {
      type: "object",
      properties: {
        intervalSec: { type: "number", description: "轮询间隔秒数，默认 15（5–120）" },
        iterations: { type: "number", description: "轮询次数，默认 5（1–20）" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          frames: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { file: { type: "string" }, changed: { type: "boolean" } },
            },
          },
        },
      },
      render: (_a, v) => text(v.frames.length
        ? v.frames.map((f) => `${f.changed ? "CHANGED" : "baseline"}: ${f.file}`).join("\n")
        : "无变化帧"),
    },
    async execute(args) {
      const interval = Math.min(Math.max(Number(args.intervalSec ?? 15), 5), 120);
      const n = Math.min(Math.max(Number(args.iterations ?? 5), 1), 20);
      return { frames: core.watch(getCfg(), interval, n) };
    },
  });

  registerTool(ctx, {
    name: "wechat_poll_start",
    description:
      "启动后台轮询：每 intervalSec 秒截一次屏，画面变化（新消息/界面切换）就存进 inbox 等 agent 读。" +
      "只读屏幕、不发消息。返回轮询状态与待处理数量。",
    parameters: {
      type: "object",
      properties: { intervalSec: { type: "number", description: "间隔秒数，默认 15（5–120）" } },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => text(`轮询已启动：每 ${v.intervalSec}s，待处理 ${v.pending} 条`),
    },
    async execute(args) {
      const { token, ...status } = poller.startPolling(getCfg(), args.intervalSec);
      return status;
    },
  });

  registerTool(ctx, {
    name: "wechat_poll_stop",
    description: "停止后台轮询。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => text(`轮询已停止，待处理 ${v.pending} 条`),
    },
    async execute() {
      return poller.stopPolling(getCfg());
    },
  });

  registerTool(ctx, {
    name: "wechat_poll_status",
    description: "查看后台轮询状态：是否运行、间隔、最后截屏时间、待处理帧数量。",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => text([
        `running=${v.running} mode=${v.mode} engine=${v.engine || "rapidocr"} interval=${v.intervalSec}s pending=${v.pending} total=${v.total}`,
        `两级轮询: ${v.probe?.enabled ? `开（每 ${v.probe.sec}s 探一次 · 帧 ${v.probe.frames ?? "?"}）` : v.probe?.broken ? "探针不可用，已退回单轮询" : "关"}`,
        `lastAt=${v.lastAt || "—"}`,
        `自动切回聊天: ${v.autoOpen === false ? "关（不在目标聊天就跳过）" : "开"}${v.openFails ? ` · 连续失败 ${v.openFails} 次` : ""}`,
        v.thread
          ? `讨论串: ${v.thread.id}（${v.thread.trigger === "mention" ? "被 @" : "自己搭话"} · ${v.thread.live ? "活着" : "已散"} · 开始 ${v.thread.ageMin} 分前 · 闲置 ${v.thread.idleMin} 分 · 上下文 ${v.thread.context} 条）`
          : "讨论串: （无）",
        v.vl ? `小模型: ${v.vl.model} 图 ${v.vl.imageTokens} tok / 出 ${v.vl.outputTokens} tok @ ${v.vl.at}` : "",
        v.quiet
          ? `空转抑制: ${v.quiet.enabled ? "开" : "关"}${v.quiet.budget?.length ? ` · ${v.quiet.budget.map((b) => `${b.chat}${b.paused ? "退避" : "冷却"}中(${b.waitSec}s)`).join("、")}` : ""}`
          : "",
        v.fallback ? `fallback: ${v.fallback}` : "",
        v.lastError ? `lastError=${v.lastError}` : "",
      ].filter(Boolean).join("\n")),
    },
    isConcurrencySafe: () => true,
    async execute() {
      return poller.pollStatus(getCfg());
    },
  });

  registerTool(ctx, {
    name: "wechat_inbox",
    description:
      "读取后台轮询攒下的“画面变化”帧：action=list 列出待处理（含截图路径，用 read_image 读）；action=ack 全部标记已读。只读，不发消息。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "ack"], description: "list（默认）或 ack" },
        unreadOnly: { type: "boolean", description: "list 时只看未读（默认 false）" },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_a, v) => {
        if (!v.entries) return text("已全部标记已读");
        if (!v.entries.length) return text(`inbox 为空（待处理 ${v.pending}）`);
        const fmt = (e) => {
          const tag = e.read ? "read" : "NEW ";
          if (e.type === "text") return `${tag}${e.at}  [文本]\n${e.text}`;
          if (e.type === "image") return `${tag}${e.at}  [图片/表情] ${e.file}`;
          return `${tag}${e.at}  [截图] ${e.file}`;
        };
        return text(v.entries.map(fmt).join("\n\n") + `\n\n待处理 ${v.pending} 条`);
      },
    },
    async execute(args) {
      const cfg = getCfg();
      if (args.action === "ack") return poller.ackInbox(cfg);
      return poller.listInbox(cfg, { unreadOnly: Boolean(args.unreadOnly) });
    },
  });
}
