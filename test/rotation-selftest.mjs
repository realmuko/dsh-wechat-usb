/**
 * 会话轮换的离线自测（不建会话、不改配置）：
 *   node test/rotation-selftest.mjs
 */
import { rotationOf, sessionFile, sessionStats } from "../lib/rotation.js";

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

// 默认值：不开启、300 轮、12MB、至少活 60 分钟、间隔 30 分钟、两个绑定都切
const d = rotationOf({});
eq("默认不开启", d.enabled, false);
eq("默认 300 轮", d.maxTurns, 300);
eq("默认 12MB", d.maxSizeMB, 12);
eq("默认最短存活", d.minAgeMin, 60);
eq("默认间隔", d.cooldownMin, 30);
eq("默认切搭话", d.switchSpeakUp, true);
eq("默认切唤醒", d.switchWake, true);

// 越界值会被夹住
const c = rotationOf({ rotation: { maxTurns: 1, maxSizeMB: 9999, minAgeMin: -5, cooldownMin: 0 } });
eq("轮数下限", c.maxTurns, 20);
eq("体积上限", c.maxSizeMB, 200);
eq("存活下限", c.minAgeMin, 0);
eq("间隔下限", c.cooldownMin, 1);

// 显式关闭联动
const off = rotationOf({ rotation: { enabled: true, switchSpeakUp: false, switchWake: false } });
eq("可以只建新会话不改绑定", [off.enabled, off.switchSpeakUp, off.switchWake], [true, false, false]);

// 不存在的会话：拿不到文件、也不抛错
eq("不存在的会话没有文件", sessionFile("session-00000000-0000-0000-0000-000000000000"), null);
eq("空 id 直接 null", sessionStats(""), null);

// 真实存在的会话（本机有就用，没有就跳过）
const real = "session-10f9a067-a85f-4aa2-9546-ebac965375ad";
const s = sessionStats(real);
if (s) {
  eq("体量字段齐全", ["bytes", "sizeMB", "turns", "ageMin"].every((k) => typeof s[k] === "number"), true);
  console.log(`     （本机会话：${s.sizeMB}MB / ${s.turns} 轮 / ${s.ageMin} 分钟）`);
} else {
  console.log("ok   （本机没有那个会话，跳过体量检查）");
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");