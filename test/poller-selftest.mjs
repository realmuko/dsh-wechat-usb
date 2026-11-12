/**
 * 轮询判定逻辑的离线自测（不碰 ADB、不碰微信）：
 *   node test/poller-selftest.mjs
 */
import { __test, setSchedule, pollStatus } from "../lib/poller.js";
import * as core from "../lib/core.js";

const { normalize, isNoise, diffNewText, classifyFresh, chatKeyOf, buildWakePrompt,
  mentionHit, mentionScopeText, wakeCooldownMs, wake, flushMentionBacklog,
  looksBare, decideQuiet, settleLastWake, resetQuietState, pushEntry } = __test;
let failed = 0;

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.log(`FAIL ${name}\n  actual   = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// normalize：中文去掉 OCR 插入的空格，英文保留单空格
eq("normalize 中文空格", normalize("阿明 同学"), "阿明同学");
eq("normalize 英文空格", normalize("hello   world"), "hello world");
eq("normalize 空行", normalize("   "), "");

// 时间戳/底栏/输入提示 → 噪声
for (const t of ["凌晨12:22", "下午3:05", "昨天 23:01", "11月10日 23:01", "12:22", "发送", "对方正在输入…", "以下是新消息"]) {
  eq(`noise: ${t}`, isNoise(t), true);
}
// 真实消息不能被误杀
for (const t of ["晚上好呀", "上午10点开会", "昨天去哪了", "12点见", "发了", "我发送了文件", "阿明同学", "读图也太弱了=-="]) {
  eq(`keep: ${t}`, isNoise(t), false);
}

// 逐帧差分：重复行只在第一帧算“新”
const prev = new Map([["A", 1], ["B", 2]]);
eq("diff 只出新行", diffNewText([{ text: "A" }, { text: "B" }, { text: "B" }, { text: "C" }], prev), [{ text: "C" }]);
eq("diff 无新行", diffNewText([{ text: "A" }, { text: "B" }], prev), []);
eq("diff 重复新行计数", diffNewText([{ text: "C" }, { text: "C" }], new Map()), [{ text: "C" }, { text: "C" }]);

// 会话标识：去掉未读数，避免 (23)→(24) 换去重桶
eq("chatKey 去未读数", chatKeyOf("示例群聊(23)"), "示例群聊");
eq("chatKey 中文括号", chatKeyOf("示例群聊（23）"), "示例群聊");
eq("chatKey 无未读数", chatKeyOf("示例群聊"), "示例群聊");
eq("chatKey 空", chatKeyOf(""), "（未识别）");

// 新消息判定：噪声/自己发的/30 分钟内出现过的都不算新
{
  const seen = new Map();
  eq("首见的新行留下", classifyFresh([{ text: "在吗" }], { seen }).length, 1);
  eq("同 30 分钟内再出现不算新", classifyFresh([{ text: "在吗" }], { seen }).length, 0);
  eq("噪声行丢弃", classifyFresh([{ text: "凌晨12:22" }, { text: "发送" }], { seen: new Map() }).length, 0);
  eq("自己发的不算新", classifyFresh([{ text: "好的" }], { own: "好的", seen: new Map() }).length, 0);
  eq("同一帧重复行只留一条", classifyFresh([{ text: "C" }, { text: "C" }], { seen: new Map() }).length, 1);
}

// ---- @ 判定 ----
const cfg = { autoReply: { mentionKeywords: ["@小助手", "@示例机器人"], noMentionIntervalMin: 30 } };

eq("mentionHit 命中", mentionHit(cfg, "在吗\n@小助手\n是这样吗？"), "@小助手");
eq("mentionHit 没命中", mentionHit(cfg, "老咸鱼\n一般我们这边统称叫电钻"), null);
eq("mentionHit 只有名字没 @ 不算", mentionHit(cfg, "小助手"), null);

// @ 行被 30 分钟去重吃掉时，仍要能从整帧里认出来（只看紧贴新行上方的那一小段）
{
  const all = [
    { text: "在吗", y: 1629 },
    { text: "什么叫他自己做了个讨论串的概念", y: 1710 },
    { text: "@小助手", y: 1898 }, // 这一行 30 分钟内出现过 → 被 diff 当成旧行
    { text: "是这样吗？", y: 1900 },
  ];
  const kept = [all[3]]; // 只有“是这样吗？”算新
  const scope = mentionScopeText(all, kept);
  eq("@ 行被去重时仍参与判定", mentionHit(cfg, scope), "@小助手");
  // 老气泡离得远（>130px）就不该被算进来
  const far = [{ text: "@小助手", y: 1000 }, { text: "新的一条", y: 1800 }];
  eq("远处旧 @ 不误判", mentionHit(cfg, mentionScopeText(far, [far[1]])), null);
}

// @ 不能被普通消息的 90s 唤醒冷却吞掉
eq("@ 冷却 ≤15s", wakeCooldownMs(cfg, true), 15000);
eq("普通消息冷却 90s", wakeCooldownMs(cfg, false), 90000);
eq("@ 冷却可配置但仍有上限", wakeCooldownMs({ autoReply: { wakeCooldownSec: 300 } }, true), 15000);

// 唤醒 prompt 里必须写死“有 @ → 必须回”，并带上命中的关键词
{
  const p = buildWakePrompt(cfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群" }, Date.now());
  eq("prompt 有 @ 必须回", p.includes("本轮有 @ 你") && p.includes("必须回一句"), true);
  eq("prompt 带上命中词", p.includes("命中「@小助手」"), true);
  const q = buildWakePrompt(cfg, "补发 @", { mention: true, mentionText: "@小助手" }, Date.now());
  eq("补发 @ 也判必须回", q.includes("必须回一句"), true);
  const b = buildWakePrompt(cfg, "新消息", { mention: true, mentionFrom: "backlog", mentionText: "@小助手" }, Date.now());
  eq("inbox 里挂着的 @ 也判必须回", b.includes("还没回") && b.includes("必须回一句"), true);
}

// ---- 唤醒冷却：@ 不能被普通消息的冷却吞掉（复现“先有普通消息、3 秒后才 @”那次误判）----
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-poller-"));
  const wcfg = { dataDir: tmp, autoReply: {
    enabled: true, wakeSessionId: "s1", wakeCooldownSec: 90,
    noMentionIntervalMin: 30, mentionKeywords: ["@小助手"],
  } };
  const prompts = [];
  setSchedule({ create: (s) => { prompts.push(s.prompt); return Promise.resolve(); } });

  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  resetQuietState();

  wake(wcfg, "新消息", { mention: false, chatTitle: "群" });
  eq("普通消息唤醒一次", prompts.length, 1);

  // 有人 @ 你：真实流程里 capture 会把这条写进 inbox
  pushEntry(wcfg, { type: "text", text: "@小助手 在吗", mentionsMe: true, mentionHit: "@小助手", chatTitle: "群" });

  t += 3000; // 3 秒后有人直接 @ —— 能插队普通消息的 90s 冷却
  wake(wcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群" });
  eq("@ 能插队普通冷却", prompts.length, 2);

  t += 3000; // 6 秒后又一个 @ —— 被 @ 自己的 15 秒合并窗口挡住
  wake(wcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群" });
  eq("@ 的 15 秒合并窗口生效", prompts.length, 2);

  t += 20000; // 过了 @ 的 15s 合并窗口
  flushMentionBacklog(wcfg);
  eq("@ 从 inbox 补发一次", prompts.length, 3);
  eq("补发的 prompt 判必须回", prompts[2].includes("必须回一句"), true);

  t += 20000;
  flushMentionBacklog(wcfg);
  eq("同一条 @ 补到上限（第 2 次）", prompts.length, 4);

  t += 20000;
  flushMentionBacklog(wcfg);
  eq("超过上限不再补", prompts.length, 4);

  t += 200000; // 冷却彻底过去后的新一波 @
  wake(wcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群" });
  eq("新一波 @ 立刻唤醒", prompts.length, 5);
  eq("新一波 @ 判必须回", prompts[4].includes("本轮有 @ 你"), true);

  Date.now = realNow;
  setSchedule(null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ================= 本地判官（4b 给出的整轮结论）：图文一起判 =================
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-quiet-"));
  const qcfg = { dataDir: tmp, autoReply: {
    enabled: true, wakeSessionId: "s1", wakeCooldownSec: 0,
    noMentionIntervalMin: 30, mentionKeywords: ["@小助手"],
    threadTtlMin: 10, threadGapSec: 20,
    quiet: { enabled: true, unknownMin: 10, emptyWakesBeforeBackoff: 2, backoffMin: 5, settleSec: 45 },
  } };

  // @ / 识图 / 主动搭话：永远不静默（判官说什么都不管用）
  eq("有 @ 不静默", decideQuiet(qcfg, { mention: true, verdict: "no", text: "哈哈哈" }).quiet, false);
  eq("识图不静默", decideQuiet(qcfg, { vision: true, verdict: "no" }).quiet, false);
  eq("主动搭话不静默", decideQuiet(qcfg, { proactive: true, mode: "idle", verdict: "no" }).quiet, false);

  // 判官说了算：不看是文字还是图片，只看这一行结论
  eq("值得回 → 唤醒（文字）", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "这个怎么弄？", verdict: "yes" }).quiet, false);
  eq("值得回 → 唤醒（图片）", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "子羽：图片：谁画的鱼", verdict: "yes" }).quiet, false);
  eq("不值得回 → 静默（文字）", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "对的", verdict: "no" }).quiet, true);
  eq("不值得回 → 静默（图片）", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "子羽：图片：游戏界面截图", verdict: "no" }).quiet, true);
  eq("不值得回 → 静默（图文混排）", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "九星噩夜：动图是这样的\n滑稽猿：图片：蓝发角色", verdict: "no" }).quiet, true);

  // 判官没给结论（退回传统 OCR）才用时间闸兜底
  eq("没判词 → 第一次放行", decideQuiet(qcfg, { mode: "thread", chat: "群T", text: "x" }).quiet, false);
  eq("没判词 → 间隔内静默", decideQuiet(qcfg, { mode: "thread", chat: "群T", text: "y" }).quiet, true);

  // prompt：带消息全文、不读 inbox、不接也 ack、时间可写 now
  const wp = buildWakePrompt(qcfg, "新消息", { mode: "thread", thread: { id: "t1", trigger: "mention", startedAt: Date.now() - 60000, context: [] }, text: "我刚吃完饭", chatTitle: "群A" }, Date.now());
  eq("prompt 带上消息文本", wp.includes("本轮新消息") && wp.includes("我刚吃完饭"), true);
  eq("prompt 不再要求先读 inbox", wp.includes("先 wechat_inbox"), false);
  eq("prompt 要求不接也 ack", wp.includes("不想接也要 ack"), true);
  eq("prompt 时间可写 now", wp.includes("now"), true);

  // 叫醒了就绝不再命令「不要回」
  const probes = [
    buildWakePrompt(qcfg, "新消息", { mode: "idle", mention: false, text: "在吗" }, Date.now()),
    buildWakePrompt(qcfg, "新消息", { mode: "thread", mention: false, text: "今天好热", thread: { id: "t1", trigger: "mention", startedAt: Date.now() - 60000, context: [] } }, Date.now()),
    buildWakePrompt(qcfg, "新消息", { mode: "mention", mention: true, mentionText: "@小助手", text: "在吗" }, Date.now()),
    buildWakePrompt(qcfg, "新画面", { vision: true, chatTitle: "群A" }, Date.now()),
  ];
  for (const [i, p] of probes.entries()) eq(`prompt#${i + 1} 无「不要回，只 ack」`, p.includes("不要回，只 ack"), false);
  eq("串模式仍是可回可不回", probes[1].includes("可以接话"), true);

  // 唤醒预算：@ 插队 / @ 合并窗口 / 补发上限 / 空转退避
  const realNow2 = Date.now;
  let t2 = realNow2();
  Date.now = () => t2;
  setSchedule({ create: () => Promise.resolve() });
  resetQuietState();
  const prompts = [];
  setSchedule({ create: (x) => { prompts.push(x.prompt); return Promise.resolve(); } });

  wake(qcfg, "新消息", { mention: false, chatTitle: "群Q", text: "随便" });
  eq("普通消息唤醒一次", prompts.length, 1);

  pushEntry(qcfg, { type: "text", text: "@小助手 在吗", mentionsMe: true, mentionHit: "@小助手", chatTitle: "群Q" });
  t2 += 3000;
  wake(qcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群Q", text: "@小助手 在吗" });
  eq("@ 能插队普通冷却", prompts.length, 2);

  t2 += 3000;
  wake(qcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群Q", text: "@小助手 在吗" });
  eq("@ 的 15 秒合并窗口生效", prompts.length, 2);

  t2 += 20000;
  flushMentionBacklog(qcfg);
  eq("@ 从 inbox 补发一次", prompts.length, 3);
  t2 += 20000;
  flushMentionBacklog(qcfg);
  eq("同一条 @ 补到上限（第 2 次）", prompts.length, 4);
  t2 += 20000;
  flushMentionBacklog(qcfg);
  eq("超过上限不再补", prompts.length, 4);

  // 空转退避：连续没换来发送 → 静默；@ 不算空转
  resetQuietState();
  wake(qcfg, "新消息", { mention: false, chat: "群B", chatTitle: "群B", mode: "thread", text: "a" });
  t2 += 60000; settleLastWake(qcfg, t2);
  wake(qcfg, "新消息", { mention: false, chat: "群B", chatTitle: "群B", mode: "thread", text: "b" });
  t2 += 60000; settleLastWake(qcfg, t2);
  eq("连续空转后退避生效", decideQuiet(qcfg, { mode: "thread", chat: "群B", text: "在干嘛", verdict: "yes" }).quiet, true);
  eq("@ 在退避里仍能叫醒", decideQuiet(qcfg, { mention: true, mode: "thread", chat: "群B", text: "在吗", verdict: "no" }).quiet, false);

  t2 += 5 * 60000;
  core.setAutoReplyState(qcfg, { lastReplyAt: t2 + 1 });
  wake(qcfg, "新消息", { mention: false, chat: "群B", chatTitle: "群B", mode: "thread", text: "好的" });
  t2 += 60000; settleLastWake(qcfg, t2);
  eq("发过消息后退避解除", decideQuiet(qcfg, { mode: "thread", chat: "群B", text: "在干嘛", verdict: "yes" }).quiet, false);

  // @ 空转不算
  core.setAutoReplyState(qcfg, { lastReplyAt: 0 });
  const before = decideQuiet(qcfg, { mode: "thread", chat: "群G", text: "随便说点啥", verdict: "yes" }).quiet;
  for (let i = 0; i < 4; i += 1) {
    wake(qcfg, "新消息", { mention: true, mentionText: "@小助手", chat: "群G", chatTitle: "群G", mode: "mention", text: "在吗" });
    t2 += 60000;
    settleLastWake(qcfg, t2);
  }
  eq("@ 空转不退避", decideQuiet(qcfg, { mode: "thread", chat: "群G", text: "随便说点啥", verdict: "yes" }).quiet, before);

  Date.now = realNow2;
  setSchedule(null);
  resetQuietState();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
