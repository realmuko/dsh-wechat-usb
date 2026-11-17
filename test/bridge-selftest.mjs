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
assert.ok(linkPrompt.includes("wechat_stickers"), "要让模型先看表情库里有哪些情绪");

console.log("bridge fallback ok");

// ---------- 主动搭话：/say 与 /state ----------
const calls2 = [];
const fetchImpl2 = async (url, init) => {
  calls2.push({ url, init });
  if (url.endsWith("/state")) {
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          world: {
            chats: {
              a: { name: "阿杰", kind: "dm", lastText: "在吗", lastFrom: "other", lastSeenAt: 200 },
              b: { name: "某个群", kind: "group", lastText: "哈哈", lastFrom: "other", lastSeenAt: 100 },
            },
          },
        });
      },
    };
  }
  if (url.endsWith("/say")) {
    return { status: 200, async text() { return JSON.stringify({ ok: true, chat: "阿杰", text: "好久没聊了" }); } };
  }
  return { status: 404, async text() { return "{}"; } };
};
const b2 = new PendingBridge({ baseUrl: "http://engine", sessionId: "s", schedule, fetchImpl: fetchImpl2 });
const chats = await b2.chats();
assert.equal(chats.length, 2);
assert.equal(chats[0].name, "阿杰", "按最近活动排序");
const said = await b2.say("阿杰", { text: "好久没聊了" });
assert.equal(said.ok, true);
const sayCall = calls2.find((c) => String(c.url).endsWith("/say"));
assert.equal(JSON.parse(sayCall.init.body).chat, "阿杰");
assert.equal(JSON.parse(sayCall.init.body).text, "好久没聊了");

console.log("bridge say ok");

// ---------- 表情库概况 ----------
const calls3 = [];
const fetchImpl3 = async (url) => {
  calls3.push(url);
  if (String(url).endsWith("/stickers")) {
    return { status: 200, async text() { return JSON.stringify({ ok: true, total: 5, moods: { 无语: 3, 开心: 2 } }); } };
  }
  return { status: 404, async text() { return "{}"; } };
};
const b3 = new PendingBridge({ baseUrl: "http://engine", sessionId: "s", schedule, fetchImpl: fetchImpl3 });
const lib = await b3.stickers();
assert.equal(lib.total, 5);
assert.equal(lib.moods["无语"], 3);
console.log("bridge stickers ok");

// ---------- 回复同时带文字和表情 ----------
const calls4 = [];
const fetchImpl4 = async (url, init) => {
  calls4.push({ url, init });
  return { status: 200, async text() { return JSON.stringify({ ok: true, chat: "阿杰", text: "笑死" }); } };
};
const b4 = new PendingBridge({ baseUrl: "http://engine", sessionId: "s", schedule, fetchImpl: fetchImpl4 });
await b4.reply("id-1", "笑死", "无语");
const replyCall4 = calls4.find((c) => String(c.url).endsWith("/pending/reply"));
const body4 = JSON.parse(replyCall4.init.body);
assert.equal(body4.text, "笑死");
assert.equal(body4.stickerMood, "无语", "文字和表情要一起给引擎");
console.log("bridge text+sticker ok");
