/**
 * 3.0 桥接：把引擎（mimicd）的「待办」变成 DSH 会话的唤醒。
 *
 * 分工：
 *   引擎：决定「该回了」——感知、去重、静默时段、频率都在它那边，它不编话。
 *   插件：轮询 /pending，用 schedule.create 叫醒一个会话；主模型回话后，
 *         插件把话 POST 回 /pending/reply，由引擎执行发送。
 *
 * 这样就保留了旧插件最值钱的那一环（主模型带着记忆和人格说话），
 * 同时把「怎么操作手机」交给引擎。
 */

import http from "node:http";

const DEFAULT_PROMPT_HEAD = [
  "你现在要用自己的微信号回一条消息。别暴露你是 AI，别解释你在做什么，只写要发出去的那一句。",
  "如果这条不值得回（比如群里的闲聊、别人之间的对话），就跳过，不要硬接。",
  "回复不超过 60 字，口语，别用书面语，别加引号。",
].join("\n");

/** 拼唤醒提示词。纯函数，方便单测。 */
export function formatPendingPrompt(item, chatKind = "dm") {
  const lines = [];
  lines.push(`会话：${item.chat}（${item.kind === "group" ? "群聊" : item.kind === "dm" ? "私聊" : "未知"}）`);
  lines.push("最近的对话（「我」是你，「对方」是聊天对象）：");
  for (const m of (item.messages || []).slice(-8)) {
    lines.push(`  ${m.from === "me" ? "我" : "对方"}：${m.text}`);
  }
  if (item.needsJudgment) {
    lines.push("");
    lines.push("注意：这是群聊，对方没有 @ 你。只有你觉得这句话轮得到你接才回；否则跳过。");
  }
  // 引擎把链接卡片标成「[链接] 标题 · 来源」；不提示的话主模型只会看到一句莫名的话
  const hasLink = (item.messages || []).some((m) => typeof m.text === "string" && m.text.startsWith("[链接]"));
  if (hasLink) {
    lines.push("");
    lines.push("对方发的是链接/推文。想读就调用工具 wechat_read_link：");
    lines.push(`  {"chat":"${item.chat}"}`);
    lines.push("（想读更早的那张再传 which，1 = 最后一张。读回标题与正文再决定怎么接；读不出来就说读不出来，别猜内容。）");
  }
  lines.push("");
  lines.push(`待办 id：${item.id}`);
  lines.push("");
  lines.push(DEFAULT_PROMPT_HEAD);
  lines.push("");
  lines.push(
    [
      "要回的话，调用工具 wechat_reply_pending：",
      `  {"id":"${item.id}","text":"你要发的那一句"}`,
      "只想回一个表情也可以（stickerMood 只能是：开心 / 无语 / 敷衍 / 惊讶 / 亲昵 / 嘲讽 / 委屈）：",
      `  {"id":"${item.id}","stickerMood":"无语"}`,
      "不想回就调用 wechat_skip_pending：",
      `  {"id":"${item.id}","reason":"为什么不回"}`,
    ].join("\n"),
  );
  return lines.join("\n");
}

/** 从待办列表里挑出没见过的。纯函数。 */
export function pickNewItems(seen, items) {
  const out = [];
  for (const item of items || []) {
    if (!item || !item.id) continue;
    if (seen.has(item.id)) continue;
    out.push(item);
  }
  return out;
}

export class PendingBridge {
  #seen = new Set();
  #timer = null;
  #busy = false;

  constructor({ baseUrl, sessionId, schedule, intervalMs = 8000, fetchImpl, log, onEvent } = {}) {
    this.baseUrl = baseUrl || "http://127.0.0.1:65480";
    this.sessionId = sessionId;
    this.schedule = schedule;
    this.intervalMs = intervalMs;
    // 不给实现就走 node:http（DSH 进程里 undici 连不上 loopback）；测试可以注入假实现
    this.fetchImpl = fetchImpl || null;
    this.log = log || (() => {});
    this.onEvent = onEvent || (() => {});
  }

  async #call(path, init = {}) {
    if (this.fetchImpl) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      const text = await res.text();
      let body2;
      try {
        body2 = JSON.parse(text);
      } catch {
        body2 = { raw: text };
      }
      return { status: res.status, body: body2 };
    }
    const url = new URL(this.baseUrl + path);
    // 动作类请求会真的在手机上跑（读一条链接 50–60s、发个表情 20s），不能沿用轮询的 10s：
    // 超时了会话会以为失败，但引擎其实已经把消息发出去了 —— 最糟的一种错。
    const timeoutMs = path.startsWith("/observe/link")
      ? 240000
      : path.startsWith("/pending/reply") || path.startsWith("/say")
        ? 180000
        : 10000;
    const payload = init.body ?? null;
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: init.method ?? "GET",
          headers: { "content-type": "application/json", ...(init.headers || {}) },
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let body;
            try {
              body = JSON.parse(data);
            } catch {
              body = { raw: data };
            }
            resolve({ status: res.statusCode || 0, body });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async fetchPending() {
    const { status, body } = await this.#call("/pending");
    if (status !== 200) throw new Error(`/pending 返回 ${status}`);
    return body.items || [];
  }

  /** 叫醒一次会话；返回 schedule 的结果（失败抛错）。 */
  async wake(item) {
    const s = this.schedule;
    if (!s || typeof s.create !== "function") throw new Error("schedule 服务不可用");
    if (!this.sessionId) throw new Error("没有配置 bridge.sessionId（要叫醒哪个会话）");
    const prompt = formatPendingPrompt(item);
    const at = new Date(Date.now() + 800).toISOString();
    const modern = {
      title: `微信消息 · ${item.chat}`,
      prompt,
      timing: { kind: "at", at },
      target: { kind: "session", sessionId: this.sessionId },
    };
    try {
      return await s.create(modern);
    } catch {
      return await s.create(this.sessionId, { title: modern.title, prompt, at });
    }
  }

  /** 一轮：取待办 → 对新的逐个唤醒。 */
  async pollOnce() {
    if (this.#busy) return 0;
    this.#busy = true;
    try {
      const items = await this.fetchPending();
      const fresh = pickNewItems(this.#seen, items);
      let woke = 0;
      for (const item of fresh) {
        this.#seen.add(item.id);
        try {
          await this.wake(item);
          woke++;
          this.log(`已叫醒会话处理「${item.chat}」（${item.id.slice(0, 8)}）`);
          this.onEvent({ type: "wake", id: item.id, chat: item.chat });
        } catch (err) {
          this.log(`叫醒失败：${err.message}`);
          this.onEvent({ type: "wake-error", id: item.id, error: err.message });
        }
      }
      // 待办里已经消失的清掉，避免无限增长
      const alive = new Set(items.map((i) => i.id));
      for (const id of this.#seen) if (!alive.has(id)) this.#seen.delete(id);
      return woke;
    } finally {
      this.#busy = false;
    }
  }

  start() {
    if (this.#timer) return;
    const tick = () => {
      this.pollOnce().catch((err) => this.log(`轮询失败：${err.message}${err.cause ? " / " + err.cause : ""}`));
    };
    tick();
    this.#timer = setInterval(tick, this.intervalMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async reply(id, text, stickerMood) {
    const payload = stickerMood ? { id, stickerMood } : { id, text };
    const { status, body } = await this.#call("/pending/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (status !== 200) throw new Error(body.error || `HTTP ${status}`);
    return body;
  }

  async readLink(chat, which) {
    const { status, body } = await this.#call("/observe/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat, which }),
    });
    if (status !== 200) throw new Error(body.error || `读链接失败 HTTP ${status}`);
    return body;
  }

  /** 主动搭话：引擎按安静时段/限额/群聊开关决定收不收 */
  async say(chat, { text, stickerMood } = {}) {
    const payload = { chat, ...(text ? { text } : {}), ...(stickerMood ? { stickerMood } : {}) };
    const { status, body } = await this.#call("/say", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (status !== 200) throw new Error(body.error || `HTTP ${status}`);
    return body;
  }

  /** 最近聊过谁：给「主动搭话」挑会话用 */
  async chats(limit = 8) {
    const { status, body } = await this.#call("/state");
    if (status !== 200) throw new Error(body.error || `HTTP ${status}`);
    const all = Object.values(body.world?.chats ?? {}).map((c) => ({
      name: c.name,
      kind: c.kind,
      lastText: String(c.lastText ?? "").slice(0, 120),
      lastFrom: c.lastFrom,
      lastSeenAt: c.lastSeenAt,
    }));
    all.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    return all.slice(0, limit);
  }

  async skip(id, reason = "") {
    const { status, body } = await this.#call("/pending/skip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, reason }),
    });
    if (status !== 200) throw new Error(body.error || `HTTP ${status}`);
    return body;
  }
}