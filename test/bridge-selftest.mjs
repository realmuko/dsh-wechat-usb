import assert from "node:assert/strict";
import { PendingBridge, formatPendingPrompt, pickNewItems } from "../lib/bridge.js";

// ---------- 纯函数 ----------
const item = {
  id: "abc-123",
  chat: "阿杰",
  kind: "dm",
  messages: [
    { from: "other", text: "在吗" },
    { from: "me", text: "在的" },
    { from: "other", text: "帮我看个东西" },
  ],
};

const prompt = formatPendingPrompt(item);
assert.ok(prompt.includes("会话：阿杰（私聊）"), "prompt 要带会话名与类型");
assert.ok(prompt.includes("对方：帮我看个东西"), "prompt 要带上下文");
assert.ok(prompt.includes("wechat_reply_pending"), "prompt 要告诉模型回话工具");
assert.ok(prompt.includes(item.id), "prompt 要带待办 id");
assert.ok(prompt.includes("别暴露你是 AI"), "要提醒模型别暴露身份");

const seen = new Set(["a"]);
assert.deepEqual(pickNewItems(seen, [{ id: "a" }, { id: "b" }, { id: "c" }]).map((x) => x.id), ["b", "c"]);
assert.deepEqual(pickNewItems(seen, [{}, null, { id: "" }]), [], "坏数据要忽略");

// ---------- 轮询 + 唤醒 ----------
const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({ url, init });
  if (url.endsWith("/pending")) {
    return { status: 200, async text() { return JSON.stringify({ ok: true, items: [item] }); } };
  }
  if (url.endsWith("/pending/reply")) {
    return { status: 200, async text() { return JSON.stringify({ ok: true, chat: "阿杰" }); } };
  }
  if (url.endsWith("/pending/skip")) {
    return { status: 200, async text() { return JSON.stringify({ ok: true }); } };
  }
  return { status: 404, async text() { return "{}"; } };
};

const wakes = [];
const schedule = {
  async create(target, legacy) {
    if (target && target.prompt) { wakes.push(target); return { ok: true }; }
    wakes.push({ legacyTarget: target, legacy });
    return { ok: true };
  },
};

const bridge = new PendingBridge({
  baseUrl: "http://engine",
  sessionId: "session-1",
  schedule,
  fetchImpl,
});

const woke = await bridge.pollOnce();
assert.equal(woke, 1, "应该叫醒一次");
assert.equal(wakes.length, 1);
assert.equal(wakes[0].target.sessionId, "session-1");
assert.ok(wakes[0].prompt.includes("帮我看个东西"));

// 第二轮：同一条待办不该重复叫醒
assert.equal(await bridge.pollOnce(), 0, "同一待办不能重复唤醒");

await bridge.reply("abc-123", "好呀，我看看");
const replyCall = calls.find((c) => String(c.url).endsWith("/pending/reply"));
assert.equal(JSON.parse(replyCall.init.body).text, "好呀，我看看");

await bridge.skip("abc-123", "闲聊");
assert.ok(calls.some((c) => String(c.url).endsWith("/pending/skip")));

// 没有 sessionId 时要报错，而不是静默不叫
const noSid = new PendingBridge({ baseUrl: "http://engine", schedule, fetchImpl });
await assert.rejects(() => noSid.wake(item), /sessionId/);

console.log("bridge selftest ok");

// ---------- 链接与表情 ----------
const linkItem = {
  id: "link-1",
  chat: "阿杰",
  kind: "dm",
  messages: [
    { from: "other", text: "[链接] 你，想家了吗？ · 人民网" },
  ],
};
const linkPrompt = formatPendingPrompt(linkItem);
assert.ok(linkPrompt.includes("wechat_read_link"), "有链接时要告诉模型能读");
assert.ok(linkPrompt.includes('"chat":"阿杰"'), "读链接要带会话名");
assert.ok(linkPrompt.includes("wechat_reply_pending"));
const plainPrompt = formatPendingPrompt(item);
assert.ok(!plainPrompt.includes("wechat_read_link"), "没有链接时不要多加噪音");
assert.ok(linkPrompt.includes("stickerMood"), "要告诉模型可以发表情");
assert.ok(linkPrompt.includes("开心"), "表情情绪要列出来");

console.log("bridge fallback ok");
