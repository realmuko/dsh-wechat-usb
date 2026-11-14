/**
 * 会话轮换：上下文攒到阈值就开一个新会话，把记忆搬过去，
 * 并把「唤醒会话（autoReply.wakeSessionId）」「主动搭话的目标会话」一起换到新会话。
 *
 * 为什么要有：轮询是一个长期挂着的会话，一条会话越聊越长，
 * 上下文越来越贵、越来越慢，也会让"她记得的"被稀释。
 * 像人一样：一台机器聊久了就换个新笔记本，但记忆是连着搬过去的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as core from "./core.js";
import { listSessions } from "./sessions.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function dataDir(cfg) {
  const d = cfg?.dataDir;
  return d && fs.existsSync(d) ? d : path.join(dshHome(), "wechat-usb");
}

function logLine(cfg, text) {
  try {
    fs.mkdirSync(dataDir(cfg), { recursive: true });
    fs.appendFileSync(path.join(dataDir(cfg), "rotation.log"), `${new Date().toISOString()}\t${text}\n`);
  } catch { /* ignore */ }
}

/** 轮换配置（都有默认值）。 */
export function rotationOf(cfg) {
  const r = cfg?.rotation && typeof cfg.rotation === "object" ? cfg.rotation : {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  return {
    enabled: r.enabled === true,
    maxTurns: num(r.maxTurns, 300, 20, 5000),
    maxSizeMB: num(r.maxSizeMB, 12, 1, 200),
    minAgeMin: num(r.minAgeMin, 60, 0, 10080),
    cooldownMin: num(r.cooldownMin, 30, 1, 10080),
    switchSpeakUp: r.switchSpeakUp !== false,
    switchWake: r.switchWake !== false,
  };
}

/** 找会话文件（session.v4.jsonl.zstd / .jsonl），找不到返回 null。 */
export function sessionFile(sid) {
  if (!sid) return null;
  const base = path.join(dshHome(), "sessions");
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { return null; }
  for (const w of workspaces) {
    const dir = path.join(base, w.name, String(sid));
    for (const name of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** 逐帧解压（DSH 的 session 文件是多段 zstd 追加写）。 */
function decompressAll(buf) {
  if (buf.length < 4 || !buf.subarray(0, 4).equals(ZSTD_MAGIC)) return buf;
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    let end = -1;
    for (let j = start + 4; j <= buf.length - 4; j++) {
      if (buf.subarray(j, j + 4).equals(ZSTD_MAGIC)) { end = j; break; }
    }
    const slice = end === -1 ? buf.subarray(start) : buf.subarray(start, end);
    try { parts.push(zlib.zstdDecompressSync(slice)); } catch { /* 半截帧忽略 */ }
    if (end === -1) break;
    start = end;
  }
  return Buffer.concat(parts);
}

function countTurns(file) {
  try {
    const text = decompressAll(fs.readFileSync(file)).toString("utf8");
    const m = text.match(/"type"\s*:\s*"user\/message"/g);
    return m ? m.length : 0;
  } catch {
    return 0;
  }
}

const statsCache = new Map();

/** 会话体量：字节数 / 轮数 / 存活分钟。 */
export function sessionStats(sid) {
  const file = sessionFile(sid);
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (statsCache.has(key)) return statsCache.get(key);
  const born = st.birthtimeMs || st.ctimeMs || st.mtimeMs;
  const out = {
    file,
    bytes: st.size,
    sizeMB: Math.round((st.size / 1048576) * 10) / 10,
    turns: countTurns(file),
    ageMin: Math.max(0, Math.round((Date.now() - born) / 60000)),
  };
  statsCache.clear();
  statsCache.set(key, out);
  return out;
}

function readConfigJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/** 把 speak-up 的目标会话里的旧 id 换成新 id。 */
function switchSpeakUp(oldId, newId) {
  const file = path.join(dshHome(), "speak-up-config.json");
  const cfg = readConfigJson(file);
  if (!cfg) return false;
  const key = Object.keys(cfg).find((k) => k === "目标会话") || "目标会话";
  const list = Array.isArray(cfg[key]) ? cfg[key].map(String) : [];
  const at = list.indexOf(String(oldId));
  if (at === -1) return false;
  list[at] = String(newId);
  cfg[key] = list;
  try {
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 4)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 记忆搬家：fish-memory 是按会话 id 存的 json，复制一份即可。 */
function migrateMemory(oldId, newId) {
  const dir = path.join(dshHome(), "fish-memory");
  const src = path.join(dir, `${oldId}.json`);
  const dst = path.join(dir, `${newId}.json`);
  let copied = false;
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      copied = true;
    }
  } catch { /* ignore */ }
  // fish-memory 的开关：没配 = 开；显式写一笔新会话，免得它以为"没配"
  try {
    const cfgFile = path.join(dshHome(), "fish-memory-config.json");
    const cfg = readConfigJson(cfgFile);
    if (cfg) {
      const m = cfg.sessions && typeof cfg.sessions === "object" ? cfg.sessions : {};
      m[String(newId)] = true;
      cfg.sessions = m;
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
    }
  } catch { /* ignore */ }
  return copied;
}

function lastRotationAt(cfg) {
  try {
    const lines = fs.readFileSync(path.join(dataDir(cfg), "rotation.log"), "utf8").trim().split("\n");
    const last = lines[lines.length - 1] || "";
    const t = Date.parse(last.split("\t")[0]);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * 检查并执行一次轮换。ctx 是插件上下文（要 sessionController 来建会话）。
 * @returns {Promise<object>} {ok, skipped?, from, to, stats, reason}
 */
export async function maybeRotate(ctx, cfg, { force = false } = {}) {
  const r = rotationOf(cfg);
  if (!force && !r.enabled) return { ok: false, skipped: "disabled" };

  const oldId = String(cfg.autoReply?.wakeSessionId || "");
  if (!oldId) return { ok: false, skipped: "no-wake-session" };

  const stats = sessionStats(oldId);
  if (!stats) return { ok: false, skipped: "no-session-file", from: oldId };

  const overTurns = stats.turns >= r.maxTurns;
  const overSize = stats.sizeMB >= r.maxSizeMB;
  if (!force && !overTurns && !overSize) {
    return { ok: false, skipped: "under-threshold", from: oldId, stats, limits: r };
  }
  if (!force && stats.ageMin < r.minAgeMin) {
    return { ok: false, skipped: "too-young", from: oldId, stats };
  }
  if (!force && Date.now() - lastRotationAt(cfg) < r.cooldownMin * 60000) {
    return { ok: false, skipped: "cooldown", from: oldId, stats };
  }

  const controller = typeof ctx?.get === "function" ? ctx.get("sessionController") : null;
  if (!controller || typeof controller.create !== "function") {
    logLine(cfg, `跳过：当前部署没有 sessionController.create（from=${oldId}）`);
    return { ok: false, skipped: "no-session-controller", from: oldId };
  }

  const cwd = (listSessions({ limit: 500 }).find((s) => s.id === oldId) || {}).cwd || "";
  let created;
  try {
    created = await controller.create(cwd ? { cwd } : {});
  } catch (e) {
    logLine(cfg, `建会话失败：${String(e?.message || e)}（from=${oldId}）`);
    return { ok: false, skipped: "create-failed", error: String(e?.message || e), from: oldId };
  }
  const newId = String(created?.sessionId || "");
  if (!newId) {
    logLine(cfg, `建会话没拿到 sessionId（from=${oldId}）`);
    return { ok: false, skipped: "no-new-id", from: oldId };
  }

  const moved = migrateMemory(oldId, newId);
  const speak = r.switchSpeakUp ? switchSpeakUp(oldId, newId) : false;
  let wake = false;
  if (r.switchWake) {
    try {
      core.saveConfig({ autoReply: { wakeSessionId: newId } });
      wake = true;
    } catch { /* ignore */ }
  }

  const reason = force ? "手动" : overTurns ? `轮数 ${stats.turns}/${r.maxTurns}` : `体积 ${stats.sizeMB}MB/${r.maxSizeMB}MB`;
  logLine(cfg, `轮换 ${oldId} → ${newId}｜原因 ${reason}｜记忆${moved ? "已搬" : "未搬"}｜搭话${speak ? "已切" : "未切"}｜唤醒${wake ? "已切" : "未切"}`);
  return { ok: true, from: oldId, to: newId, stats, reason, memory: moved, speakUp: speak, wake };
}