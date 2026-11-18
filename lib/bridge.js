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
  "群聊里可以主动一点：有自然的接话口就接（玩梗、吐槽、附和、发个表情都算），不用等别人点你；只有完全插不上、或者会打断别人正事时才跳过。",
  "回复不超过 60 字，口语，别用书面语，别加引号。",
  "不用每条都写字：被逗笑、无语、敷衍、震惊的时候，直接回一个表情往往更像人（但别每条都发表情）。",
].join("\n");

/** 一条待办最多尝试叫醒几次；到了上限才标记成"已处理"，免得无限重试刷日志 */
const WAKE_MAX_ATTEMPTS = 3;

/**
 * 叫醒（schedule.create）最长等多久。
 * 那个调用是 DSH 的 schedule 服务，会话忙的时候可能排很久；但它也可能永远不 resolve，
 * 一旦挂住 #busy 就再也不复位，整个桥接静默死掉（2026-11-18 14:15 就是这么停的）。
 * 超时当作这次叫醒失败，走已有的重试计数，别拖死轮询。
 */
const WAKE_TIMEOUT_MS = 25000;

/** 一轮轮询最多允许多久；超了就当它卡死，强制复位 #busy 并记一笔 */
const POLL_STALL_MS = 60000;

/** 给一个 promise 套超时；超时抛错，标签进 error.message，方便日志里认出是哪一步 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    // 这里不能 unref：万一这是事件循环里唯一活着的 handle（单测、脚本里很常见），
    // unref 会让 Node 直接退出，调用方永远等不到结果。反正 settle 后会被 finally 清掉。
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 拼唤醒提示词。纯函数，方便单测。 */
export function formatPendingPrompt(item, chatKind = "dm", moods = null) {
  const lines = [];
  lines.push(`会话：${item.chat}（${item.kind === "group" ? "群聊" : item.kind === "dm" ? "私聊" : "未知"}）`);
  lines.push(
    item.kind === "group"
      ? "最近的对话（「我」是你；其他人名字就是发这句话的人，接话时可以对上人）："
      : "最近的对话（「我」是你，「对方」是聊天对象）：",
  );
  for (const m of (item.messages || []).slice(-8)) {
    const who = m.from === "me" ? "我" : m.sender ? String(m.sender) : "对方";
    lines.push(`  ${who}：${m.text}`);
  }
  if (item.kind === "group") {
    lines.push("");
    lines.push("群聊回话时：玩梗、吐槽、附和这种轻松的话，**顺手带一个情绪对得上的表情**（text 和 stickerMood 一起给）；两三句里带一次就行；正经的技术/工作讨论别带。");
  }
  if (item.needsJudgment) {
    lines.push("");
    lines.push("注意：这是群聊，对方没有 @ 你 —— 但你可以主动接话：有梗可接、有人在吐槽、气氛轻松时，就接一句或回个表情，不用怕插嘴。");
  }
  // 引擎把链接卡片标成「[链接] 标题 · 来源」；不提示的话主模型只会看到一句莫名的话
  const hasLink = (item.messages || []).some((m) => typeof m.text === "string" && m.text.startsWith("[链接]"));
  if (hasLink) {
    lines.push("");
    lines.push("对方发的是链接/推文。想读就调用工具 wechat_read_link：");
    lines.push(`  {"chat":"${item.chat}"}`);
    lines.push("（想读更早的那张再传 which，1 = 最后一张。读回标题与正文再决定怎么接；读不出来就说读不出来，别猜内容。）");
  }
  if (moods && Object.keys(moods).length > 0) {
    lines.push("");
    lines.push(`表情库现有：${Object.entries(moods).map(([mood, n]) => `${mood} ${n} 张`).join("、")}`);
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
      "文字和表情可以一起给（先发文字，再补一个表情）。轻松的话就带一个，不用每条都带：",
      `  {"id":"${item.id}","text":"这句话说完再补个表情","stickerMood":"无语"}`,
      "只回一个表情也可以（不写字）：",
      `  {"id":"${item.id}","stickerMood":"无语"}`,
      "不确定库里有没有合适的情绪，就调 wechat_stickers 看一眼再挑。",
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
  /** 叫醒失败次数：id -> 次数 */
  #attempts = new Map();
  #timer = null;
  #busy = false;
  /** #busy 是什么时候置上的：看门狗靠它判断这一轮是不是已经卡死 */
  #busySince = 0;

  constructor({ baseUrl, sessionId, schedule, intervalMs = 8000, fetchImpl, log, onEvent, wakeTimeoutMs = WAKE_TIMEOUT_MS, stallMs = POLL_STALL_MS } = {}) {
    this.baseUrl = baseUrl || "http://127.0.0.1:65480";
    this.sessionId = sessionId;
    this.schedule = schedule;
    this.intervalMs = intervalMs;
    // 单测可以调小这两个来快速验证卡死路径
    this.wakeTimeoutMs = wakeTimeoutMs;
    this.stallMs = stallMs;
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

  /** 会话轮换后用：不重建桥接实例，直接切到新会话 */
  setSessionId(id) {
    if (!id) return false;
    this.sessionId = String(id);
    return true;
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
    let moods = null;
    try {
      moods = (await this.stickers()).moods ?? null;
    } catch {
      moods = null;
    }
    const prompt = formatPendingPrompt(item, undefined, moods);
    const at = new Date(Date.now() + 800).toISOString();
    const modern = {
      title: `微信消息 · ${item.chat}`,
      prompt,
      timing: { kind: "at", at },
      target: { kind: "session", sessionId: this.sessionId },
    };
    try {
      return await withTimeout(
        s.create(modern),
        this.wakeTimeoutMs,
        `叫醒超时：${this.wakeTimeoutMs / 1000}s 内 schedule.create 没返回`,
      );
    } catch (err) {
      // 超时的场合不要再拿旧签名重试：create 可能只是慢，再叫一次等于重复唤醒。
      if (/叫醒超时/.test(String(err?.message))) throw err;
      return await withTimeout(
        s.create(this.sessionId, { title: modern.title, prompt, at }),
        this.wakeTimeoutMs,
        `叫醒超时（旧签名）：${this.wakeTimeoutMs / 1000}s 内 schedule.create 没返回`,
      );
    }
  }

  /** 一轮：取待办 → 对新的逐个唤醒。 */
  async pollOnce() {
    if (this.#busy) return 0;
    this.#busy = true;
    this.#busySince = Date.now();
    try {
      const items = await this.fetchPending();
      const fresh = pickNewItems(this.#seen, items);
      let woke = 0;
      for (const item of fresh) {
        try {
          await this.wake(item);
          this.#seen.add(item.id);
          this.#attempts.delete(item.id);
          woke++;
          this.log(`已叫醒会话处理「${item.chat}」（${item.id.slice(0, 8)}）`);
          this.onEvent({ type: "wake", id: item.id, chat: item.chat });
        } catch (err) {
          // 叫醒失败不能当成"已处理"：以前是先 add 再 wake，失败一次这条待办就永远没人回了。
          // 允许重试，但要有上限，免得一条坏待办每 8 秒刷一辈子日志。
          const n = (this.#attempts.get(item.id) ?? 0) + 1;
          this.#attempts.set(item.id, n);
          if (n >= WAKE_MAX_ATTEMPTS) {
            this.#seen.add(item.id);
            this.#attempts.delete(item.id);
            this.log(`叫醒失败 ${n} 次，放弃这条「${item.chat}」（${item.id.slice(0, 8)}）：${err.message}`);
          } else {
            this.log(`叫醒失败（第 ${n}/${WAKE_MAX_ATTEMPTS} 次，下次重试）：${err.message}`);
          }
          this.onEvent({ type: "wake-error", id: item.id, error: err.message });
        }
      }
      // 待办里已经消失的清掉，避免无限增长
      const alive = new Set(items.map((i) => i.id));
      for (const id of this.#seen) if (!alive.has(id)) this.#seen.delete(id);
      for (const id of this.#attempts.keys()) if (!alive.has(id)) this.#attempts.delete(id);
      return woke;
    } finally {
      this.#busy = false;
      this.#busySince = 0;
    }
  }

  /**
   * 卡死的轮询：强制把 #busy 复位，让下一拍能重新开始。
   * 原因：pollOnce 里任何一步永久挂住（尤其 schedule.create），#busy 就永远 true，
   * 之后每拍一进门就 return 0，连失败日志都没有 —— 桥接看着像活着，其实再也没动过。
   * 返回是否真的复位了。
   */
  #unstick() {
    if (!this.#busy) return false;
    const stuckMs = Date.now() - this.#busySince;
    if (stuckMs < this.stallMs) return false;
    this.#busy = false;
    this.#busySince = 0;
    this.log(`看门狗：上一轮轮询卡了 ${Math.round(stuckMs / 1000)}s 没结束，强制复位重来`);
    this.onEvent({ type: "watchdog-reset", stuckMs });
    return true;
  }

  start() {
    if (this.#timer) return;
    this.log(
      `桥接启动：每 ${this.intervalMs}ms 轮询 · 看门狗 ${Math.round(this.stallMs / 1000)}s · 叫醒超时 ${Math.round(this.wakeTimeoutMs / 1000)}s`,
    );
    const tick = () => {
      // 先看一眼上一轮是不是早该结束了；卡死就复位，否则这一拍又是空转。
      try { this.#unstick(); } catch { /* ignore */ }
      this.pollOnce().catch((err) => this.log(`轮询失败：${err.message}${err.cause ? " / " + err.cause : ""}`));
    };
    tick();
    this.#timer = setInterval(tick, this.intervalMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#busy = false;
    this.#busySince = 0;
  }

  async reply(id, text, stickerMood) {
    // 文字和表情可以一起给：引擎先发文字，再补一个表情
    const payload = { id };
    if (text) payload.text = text;
    if (stickerMood) payload.stickerMood = stickerMood;
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

  /** 表情库概况：给主模型挑情绪用 */
  async stickers() {
    const { status, body } = await this.#call("/stickers");
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