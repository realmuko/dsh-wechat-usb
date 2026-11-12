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

// ================= 空转抑制（quiet）：别为「看到了但不需要回」付模型钱 =================
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-quiet-"));
  const qcfg = { dataDir: tmp, autoReply: {
    enabled: true, wakeSessionId: "s1", wakeCooldownSec: 0,
    noMentionIntervalMin: 30, mentionKeywords: ["@小助手"],
    threadTtlMin: 10, threadGapSec: 20,
    quiet: { enabled: true, emptyWakesBeforeBackoff: 2, backoffMin: 5, settleSec: 45 },
  } };

  // 纯反应/表情 → 本地放过
  for (const t of ["哈哈哈哈", "草", "666", "🌚🌚", "嗯嗯", "好的", "！！"]) eq(`bare ${t}`, looksBare(t), true);
  for (const t of ["在吗", "这个怎么弄", "刚那个图再发一次", "收到了谢谢"]) eq(`not bare ${t}`, looksBare(t), false);

  // @ / 识图 / 主动搭话：永远不静默
  eq("有 @ 不静默", decideQuiet(qcfg, { mention: true, text: "哈哈哈" }).quiet, false);
  eq("识图不静默", decideQuiet(qcfg, { vision: true, text: "哈哈哈" }).quiet, false);
  eq("主动搭话不静默", decideQuiet(qcfg, { proactive: true, mode: "idle", text: "哈哈哈" }).quiet, false);
  // 刚参与过、没 @、又没到间隔：插件自己就能判「不要回」→ 本地 ack 就行
  core.setAutoReplyState(qcfg, { lastReplyAt: Date.now(), lastNoMentionAt: Date.now() });
  eq("无@未到间隔 → 本地 ack", decideQuiet(qcfg, { mode: "idle", chat: "群Z", text: "我刚吃完饭" }).quiet, true);

  // 串里：纯反应放过；问句/正常内容照旧叫模型
  eq("串里纯反应放过", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "哈哈哈哈" }).quiet, true);
  eq("串里问句照旧", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "这个怎么弄？" }).quiet, false);
  eq("串里正常内容照旧", decideQuiet(qcfg, { mode: "thread", chat: "群A", text: "我刚吃完饭" }).quiet, false);

  // 连带消息文本的 prompt：不让模型再花一轮去 wechat_inbox 读
  const wp = buildWakePrompt(qcfg, "新消息", { mode: "thread", mention: false, text: "我刚吃完饭\n好吃吗", chatTitle: "群A" }, Date.now());
  eq("prompt 带上消息文本", wp.includes("本轮新消息") && wp.includes("我刚吃完饭"), true);
  eq("prompt 不再要求先读 inbox", wp.includes("先 wechat_inbox"), false);
  eq("prompt 要求同一轮 ack", wp.includes("同一轮里"), true);

  // 叫醒了就绝不再命令「不要回」—— 那是闸门的活，不是 prompt 的活
  const probes = [
    buildWakePrompt(qcfg, "新消息", { mode: "idle", mention: false, text: "在吗" }, Date.now()),
    buildWakePrompt(qcfg, "新消息", { mode: "thread", mention: false, text: "今天好热", thread: { id: "t1", trigger: "mention", startedAt: Date.now() - 60000, context: [] } }, Date.now()),
    buildWakePrompt(qcfg, "新消息", { mode: "mention", mention: true, mentionText: "@小助手", text: "在吗" }, Date.now()),
    buildWakePrompt(qcfg, "新画面", { vision: true, chatTitle: "群A" }, Date.now()),
  ];
  for (const [i, p] of probes.entries()) eq(`prompt#${i + 1} 无「不要回，只 ack」`, p.includes("不要回，只 ack"), false);
  eq("串模式仍是可回可不回", probes[1].includes("可以接话"), true);

  // 图片描述成文字：整条只有图片 → 不唤醒（wakeOnImage 关着时）
  for (const t of [
    "子羽：图片：游戏界面截图，有进度条和小窗口",
    "子羽：图片：显示“请客没钱”字样\n子羽：图片：游戏界面截图",
    "图片",
    "[图片]",
  ]) eq(`imageOnly ${t.slice(0, 12)}`, __test.isImageOnly(t), true);
  for (const t of ["子羽：图片：截图\n子羽：哈哈哈", "子羽：这图什么意思", "子羽：[图片] 你看这个"]) {
    eq(`not imageOnly ${t.slice(0, 12)}`, __test.isImageOnly(t), false);
  }
  eq("整条图片 → 第一张放行", decideQuiet(qcfg, { mode: "thread", chat: "群D", text: "子羽：图片：游戏界面截图" }).quiet, false);
  eq("紧接着的图不再唤醒", decideQuiet(qcfg, { mode: "thread", chat: "群D", text: "子羽：图片：全是玩偶" }).quiet, true);
  // text 模式下图片只有判词一条路：wakeOnImage 不再另起一条分支
  eq("wakeOnImage 开着也不推翻判词", decideQuiet(
    { ...qcfg, autoReply: { ...qcfg.autoReply, wakeOnImage: true } },
    { mode: "thread", chat: "群E", text: "子羽：图片：游戏界面截图", worth: "no" },
  ).quiet, true);
  eq("@ 时图片也唤醒", decideQuiet(qcfg, { mention: true, mode: "thread", chat: "群D", text: "子羽：图片：游戏界面截图" }).quiet, false);

  // 本地 4b 的判词优先于时间闸
  eq("判词 否 → 不唤醒", decideQuiet(qcfg, { mode: "thread", chat: "群F", text: "子羽：图片：游戏界面截图", worth: "no" }).quiet, true);
  decideQuiet(qcfg, { mode: "thread", chat: "群F", text: "子羽：图片：谁画的鱼", worth: "yes" });
  eq("判词 是 → 照唤醒", decideQuiet(qcfg, { mode: "thread", chat: "群F", text: "子羽：图片：谁画的鱼", worth: "yes" }).quiet, false);
  eq("WORTH_RE 认全角/空格", "子羽：图片：xxx ｜ 值得: 否".match(__test.WORTH_RE)?.[1], "否");
  eq("WORTH_RE 也认冒号分隔", "九星噩夜：图片：小鱼图案：值得:否".match(__test.WORTH_RE)?.[1], "否");
  eq("WORTH_STRIP_RE 剥干净", "子羽：图片：xxx｜值得:是".replace(__test.WORTH_STRIP_RE, ""), "子羽：图片：xxx");
  eq("WORTH_STRIP_RE 也剥冒号版", "九星噩夜：图片：小鱼图案：值得:否".replace(__test.WORTH_STRIP_RE, ""), "九星噩夜：图片：小鱼图案");

  // 空转退避：连两次唤醒都没换来发送 → 静默；静默里只有问句能叫醒
  const realNow2 = Date.now;
  let t2 = realNow2();
  Date.now = () => t2;
  setSchedule({ create: () => Promise.resolve() });
  resetQuietState();

  wake(qcfg, "新消息", { mention: false, chat: "群B", chatTitle: "群B", mode: "thread", text: "我刚吃完饭" });
  t2 += 60000;
  settleLastWake(qcfg, t2);
  wake(qcfg, "新消息", { mention: false, chat: "群B", chatTitle: "群B", mode: "thread", text: "我也刚吃完" });
  t2 += 60000;
  settleLastWake(qcfg, t2);
  eq("连续空转后退避生效", decideQuiet(qcfg, { mode: "thread", chat: "群B", text: "在干嘛" }).quiet, true);
  eq("退避里问句仍叫醒", decideQuiet(qcfg, { mode: "thread", chat: "群B", text: "几点了？" }).quiet, false);

  // 真发了消息 → 退避清零（先等退避到点，退避里普通消息本来就不叫）
  t2 += 5 * 60000;
  core.setAutoReplyState(qcfg, { lastReplyAt: t2 + 1 });
  wake(qcfg, "新消息", { mention: false, chat: "群B", chatTitle: "群B", mode: "thread", text: "好的" });
  t2 += 60000;
  settleLastWake(qcfg, t2);
  eq("发过消息后退避解除", decideQuiet(qcfg, { mode: "thread", chat: "群B", text: "在干嘛" }).quiet, false);

  // 被 @ 的唤醒没回，不算空转 —— 不能因为它把整个群静默掉
  {
    core.setAutoReplyState(qcfg, { lastReplyAt: 0 });
    const before = decideQuiet(qcfg, { mode: "thread", chat: "群G", text: "随便说点啥" }).quiet;
    for (let i = 0; i < 4; i += 1) {
      wake(qcfg, "新消息", { mention: true, mentionText: "@小助手", chat: "群G", chatTitle: "群G", mode: "mention", text: "在吗" });
      t2 += 60000;
      settleLastWake(qcfg, t2);
    }
    eq("@ 空转不退避", decideQuiet(qcfg, { mode: "thread", chat: "群G", text: "随便说点啥" }).quiet, before);
  }

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
