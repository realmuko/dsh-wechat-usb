/**
 * 轮询判定逻辑的离线自测（不碰 ADB、不碰微信）：
 *   node test/poller-selftest.mjs
 */
import { __test, setSchedule, pollStatus } from "../lib/poller.js";
import * as core from "../lib/core.js";

const { normalize, isNoise, diffNewText, classifyFresh, chatKeyOf, buildWakePrompt,
  mentionHit, mentionScopeText, wakeCooldownMs, wake, flushMentionBacklog,
  decideQuiet, settleLastWake, resetQuietState, pushEntry, keyedLines, lineKey, sameAnimationZone,
  isUiNoise, multiOf, parseListRows, chooseCandidate, sameChatName, rememberLines } = __test;
const countsOfFor = (lines) => { const m = new Map(); for (const l of lines) m.set(l.key || l.text, (m.get(l.key || l.text) || 0) + 1); return m; };
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
  // 连着发几条：前面几条也要认出来（这是"自己回自己"的根因）
  {
    const ownList = ["然后你嘎嘎乱杀", "英雄单位还被乱杀"];
    const fresh = [
      { text: "我：然后你嘎嘎乱杀" },
      { text: "我：英雄单位还被乱杀，听着跟我差不多" },
      { text: "德师傅：这鱼真会说话" },
    ];
    const kept = classifyFresh(fresh, { ownList, seen: new Map() });
    eq("连着发的几条自己消息都过滤掉", kept.length, 1);
    eq("别人的话没被误伤", kept[0].text, "德师傅：这鱼真会说话");

    // 真实事故：她发「在呢，叫我就应一声」，OCR 读成「我：在呢，叫我一声」
    const k2 = classifyFresh([{ text: "我：在呢，叫我一声" }], { ownList: ["在呢，叫我就应一声"], seen: new Map() });
    eq("绿气泡标「我：」直接过滤", k2.length, 0);

    // 就算 VL 没标「我：」，OCR 读歪一两个字也要认出来
    const k3 = classifyFresh([{ text: "在呢，叫我一声" }], { ownList: ["在呢，叫我就应一声"], seen: new Map() });
    eq("OCR 读歪一两个字也能认出来", k3.length, 0);

    // 别人的正常发言不能被误杀
    const k4 = classifyFresh([{ text: "德师傅：在呢，叫我一声呗" }], { ownList: ["在呢，叫我就应一声"], seen: new Map() });
    eq("别人说的类似话不误杀", k4.length, 1);
  }
  eq("同一帧重复行只留一条", classifyFresh([{ text: "C" }, { text: "C" }], { seen: new Map() }).length, 1);
}

// ---- 动图识别：身份=文字，是否"同一张动图"交给像素差异 ----
{
  // 图片行的身份就是它的文字（不再用位置：位置会被复用，会把新图当旧图吞掉）
  eq("图片身份就是文字", lineKey({ text: "子羽：图片：猫在挥手" }), "子羽：图片：猫在挥手");
  eq("不同描述的图身份不同", lineKey({ text: "子羽：图片：猫站着" }) === lineKey({ text: "子羽：图片：猫在挥手" }), false);

  // 像素带判定：窄带 + 中心没挪窝 = 同一处还在动（动图）
  const rows = 410;
  eq("窄带中心没动 → 是动图", sameAnimationZone({ band: [185, 231] }, { band: [183, 232], rows }, rows), true);
  eq("窄带轻微游移 → 还是动图", sameAnimationZone({ band: [145, 223] }, { band: [185, 231], rows }, rows), true);
  eq("整屏变化（滚动/新消息）→ 不是动图", sameAnimationZone({ band: [7, 410] }, { band: [8, 403], rows }, rows), false);
  eq("中心挪得远 → 不是动图", sameAnimationZone({ band: [10, 60] }, { band: [300, 350], rows }, rows), false);
  eq("上一帧没有变化带 → 不是动图", sameAnimationZone({ band: null }, { band: [10, 60], rows }, rows), false);
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

// 昵称后缀箭头每帧抖动 → normalize 后应当一致，去重才不会失效
eq("normalize 洗掉箭头", normalize("德师傅↑→↓↓↓：晚上好"), normalize("德师傅↑↓↓：晚上好"));

// 引用头 / 自己气泡的回显：没有「昵称：」前缀，不算有人 @
{
  const scope = mentionScopeText(
    [{ text: "@升天肥鱼：德师傅↑→↓↓↓：动图是这样的", y: 1800 }],
    [{ text: "九星噩夜：动图是这样的", y: 1830 }],
    new Map(),
  );
  eq("没有昵称前缀的 @ 不算真 @", mentionHit(cfg, scope), null);
}
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

  // 旧的那条 @（在上一次唤醒之前就在屏幕上了）不该被补发——模型已经看过那个画面
  t += 50000;
  flushMentionBacklog(wcfg);
  eq("唤醒之前就存在的 @ 不补发", prompts.length, 2);

  // 补发最多一次：再 flush 也不该多叫
  const n0 = prompts.length;
  t += 50000;
  flushMentionBacklog(wcfg);
  eq("同一条 @ 只补一次", prompts.length, n0);

  t += 200000; // 冷却彻底过去后的新一波 @
  wake(wcfg, "新消息", { mention: true, mentionText: "@小助手", chatTitle: "群" });
  eq("新一波 @ 立刻唤醒", prompts.length, n0 + 1);
  eq("新一波 @ 判必须回", prompts[prompts.length - 1].includes("本轮有 @ 你"), true);



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

  // （@ 插队 / 合并窗口 / 补发上限 的用例在上面 wcfg 那个块里，别重复）
  setSchedule(null);
  resetQuietState();
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---------------- v2 多会话 ---------------- */

// 界面噪声：浮层横幅 / 引用提示 / 时间戳，不算聊天内容
for (const t of ["微信：刚刚", "微信:昨天", "有人@我", "以下为新消息", "[16条]", "12:22"]) {
  eq(`ui-noise: ${t}`, isUiNoise(t), true);
}
for (const t of ["毁灭菇翘嘴软饭群", "球球别抓我：晚上好", "在吗", "今天 8:55 开会"]) {
  eq(`ui-keep: ${t}`, isUiNoise(t), false);
}

// 列表行解析（Windows OCR 的行，带坐标）
const listRows = parseListRows([
  { text: "毁灭菇翘嘴软饭群", x: 200, y: 340, w: 400 },
  { text: "球球别抓我：哦？", x: 200, y: 390, w: 400 },
  { text: "15", x: 980, y: 340, w: 40 },
  { text: "zhyk", x: 200, y: 500, w: 100 },
  { text: "测试信息，你说要发一条纯文字消息给你看的", x: 200, y: 550, w: 500 },
  { text: "1", x: 980, y: 500, w: 20 },
]);
eq("列表行数", listRows.length, 2);
eq("群行", { name: listRows[0]?.name, unread: listRows[0]?.unread, isGroup: listRows[0]?.isGroup },
  { name: "毁灭菇翘嘴软饭群", unread: 15, isGroup: true });
eq("私聊行", { name: listRows[1]?.name, unread: listRows[1]?.unread, isGroup: listRows[1]?.isGroup },
  { name: "zhyk", unread: 1, isGroup: false });
// 行中心取的是这一行所有文字的外接框中心（名字 340 + 预览 390/432）
eq("行中心取自包围盒", listRows[0]?.y, 386);
// 右边的时间（x≈900）不能被当成会话名
const listRows2 = parseListRows([
  { text: "上午10：16", x: 894, y: 378, w: 141 },
  { text: "知乎102个好兄弟有2个人领了", x: 206, y: 381, w: 627 },
  { text: "张北海：恭喜啊！做爸爸了！", x: 207, y: 446, w: 410 },
]);
eq("时间行不当会话名", listRows2[0]?.name, "知乎102个好兄弟有2个人领了");
eq("时间行的预览", listRows2[0]?.preview, "张北海：恭喜啊！做爸爸了！");

// 挑会话：@提示 > 私聊 > 群聊；未读没涨就不重复挑
const cfgM = { autoReply: { enabled: true } };
const nowM = Date.now();
const rowsM = [
  { name: "甲群", unread: 3, isGroup: true, preview: "a: b", y: 300 },
  { name: "乙私聊", unread: 2, isGroup: false, preview: "在吗", y: 450 },
  { name: "丙群", unread: 5, isGroup: true, preview: "有人@我", y: 600 },
];
const c1 = chooseCandidate(cfgM, rowsM, nowM);
eq("优先挑被 @ 的群", c1 && c1.name, "丙群");
const c2 = chooseCandidate(cfgM, rowsM, nowM + 1000);
eq("未读没涨就不再挑", c2, null);

// 会话名比对：列表里的名字被省略号截断、标题里带「(23)」，都要能对上
eq("名字被截断也能对上", sameChatName("知乎102个好兄弟有2个人领了“", "知乎102个好兄弟…领了50人份(101)"), true);
eq("群名带成员数", sameChatName("毁灭菇翘嘴软饭群", "毁灭菇翘嘴软饭群(23)"), true);
eq("私聊同名", sameChatName("zhyk", "zhyk"), true);
eq("不同会话判不同", sameChatName("zhyk", "球球别抓我"), false);
eq("读不到名字不判错", sameChatName("", "随便"), true);

// 识图描述每帧措辞不同 —— 必须归一，否则每帧都算"新消息"（曾把唤醒刷成 30 秒 8 次）
eq("识图描述归一", lineKey({ text: "图片：猫，睁大眼睛，表情惊讶" }), "〔图片〕");
eq("识图描述归一2", lineKey({ text: "图片：猫，睁大眼睛，有滤镜效果" }), "〔图片〕");
eq("昵称前缀剥掉", lineKey({ text: "昵称：@升天肥鱼在吗" }), "@升天肥鱼在吗");
const imgPrev = countsOfFor(keyedLines([{ text: "图片：猫，睁大眼睛" }]));
eq("换措辞的同一张图不算新", diffNewText(keyedLines([{ text: "图片：猫，睁大眼睛，有滤镜" }]), imgPrev), []);

// 跨会话隔离：换会话时必须清空上下文，别把上一个群的话带进这个群的讨论串
rememberLines([{ text: "A群说的话", y: 100 }], Date.now(), "chatA");
rememberLines([{ text: "B群说的话", y: 100 }], Date.now(), "chatB");
eq("换会话后上下文不串", __test.recentLinesOf().map((x) => x.text), ["B群说的话"]);

// 唤醒 prompt 必须写明跨会话隔离
const isoPrompt = buildWakePrompt({ autoReply: {} }, "新消息",
  { mode: "mention", mention: true, mentionText: "@小助手", text: "在吗", chatTitle: "群A" }, Date.now());
eq("prompt 有跨会话隔离", isoPrompt.includes("跨会话隔离"), true);
eq("prompt 点名当前会话", isoPrompt.includes("群A"), true);

// 多会话配置默认值
const mDef = multiOf({});
eq("multi 默认开启", mDef.enabled, true);
eq("multi 默认 15s 扫列表", mDef.listScanSec, 15);
eq("multi 可显式关闭", multiOf({ multi: { enabled: false } }).enabled, false);

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
