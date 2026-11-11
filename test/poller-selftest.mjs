/**
 * 轮询判定逻辑的离线自测（不碰 ADB、不碰微信）：
 *   node test/poller-selftest.mjs
 */
import { __test, setSchedule, pollStatus } from "../lib/poller.js";

const { normalize, isNoise, diffNewText, classifyFresh, chatKeyOf, buildWakePrompt,
  mentionHit, mentionScopeText, wakeCooldownMs, wake, flushPendingMention } = __test;
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

  wake(wcfg, "新消息", { mention: false, chatTitle: "群" });
  eq("普通消息唤醒一次", prompts.length, 1);

  t += 3000; // 3 秒后有人直接 @
  wake(wcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群" });
  eq("@ 被短窗口挡下时记进 pending", Boolean(pollStatus(wcfg).pendingMention), true);

  t += 20000; // 过了 @ 的 15s 合并窗口
  flushPendingMention(wcfg);
  eq("@ 到点补发一次", prompts.length, 2);
  eq("补发的 prompt 判必须回", prompts[1].includes("必须回一句"), true);

  t += 200000; // 冷却彻底过去后的新一波 @
  wake(wcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群" });
  eq("新一波 @ 立刻唤醒", prompts.length, 3);
  eq("新一波 @ 判必须回", prompts[2].includes("本轮有 @ 你"), true);

  Date.now = realNow;
  setSchedule(null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
