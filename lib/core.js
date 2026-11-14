import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const EXAMPLE_CONFIG = path.join(ROOT, "wechat-usb.config.example.json");

/** 配置路径：默认插件目录下的 wechat-usb.config.json，可用 WECHAT_USB_CONFIG 覆盖。 */
export function configPath() {
  return process.env.WECHAT_USB_CONFIG || path.join(ROOT, "wechat-usb.config.json");
}

/** 首次运行（如刚 clone 仓库）没有真实配置时，从示例配置生成一份，避免一开就崩。 */
function ensureConfig(file) {
  if (fs.existsSync(file)) return;
  if (!fs.existsSync(EXAMPLE_CONFIG)) return;
  try {
    fs.copyFileSync(EXAMPLE_CONFIG, file);
    console.warn(`[dsh-wechat-usb] 未找到配置，已从 ${path.basename(EXAMPLE_CONFIG)} 生成：${file}`);
  } catch (e) {
    console.warn(`[dsh-wechat-usb] 生成配置失败：${e.message}`);
  }
}

export function configInfo() {
  const file = configPath();
  ensureConfig(file);
  return { path: file, mtime: fs.statSync(file).mtimeMs, cfg: loadConfig(file) };
}

const numIn = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** 只接受已知字段 + 类型/范围校验，防止设置页把配置写坏。 */
export function mergeConfig(base, patch = {}) {
  const out = JSON.parse(JSON.stringify(base));
  if (typeof patch.adb === "string" && patch.adb.trim()) out.adb = patch.adb.trim();
  if (typeof patch.serial === "string" && patch.serial.trim()) out.serial = patch.serial.trim();
  if (typeof patch.dataDir === "string" && patch.dataDir.trim()) out.dataDir = patch.dataDir.trim();
  if (patch.ime && typeof patch.ime === "object") {
    for (const k of ["default", "inject"]) {
      if (typeof patch.ime[k] === "string" && patch.ime[k].trim()) out.ime[k] = patch.ime[k].trim();
    }
  }
  if (patch.coords && typeof patch.coords === "object") {
    for (const k of Object.keys(out.coords || {})) {
      const v = patch.coords[k];
      if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(Number(n)))) {
        out.coords[k] = [Math.round(Number(v[0])), Math.round(Number(v[1]))];
      }
    }
  }
  if (patch.mode === "text" || patch.mode === "frame") out.mode = patch.mode;
  if (patch.autoReply && typeof patch.autoReply === "object") {
    const a = out.autoReply || (out.autoReply = {});
    if (typeof patch.autoReply.enabled === "boolean") a.enabled = patch.autoReply.enabled;
    // 允许清空：设置页选「不选」时把目标会话删掉，有新消息就只进 inbox、不唤醒模型
    if (typeof patch.autoReply.wakeSessionId === "string") {
      const v = patch.autoReply.wakeSessionId.trim();
      if (v) a.wakeSessionId = v;
      else delete a.wakeSessionId;
    }
    a.intervalSec = numIn(patch.autoReply.intervalSec, 5, 300, a.intervalSec ?? 15);
    if (typeof patch.autoReply.autoOpen === "boolean") a.autoOpen = patch.autoReply.autoOpen;
    a.threadTtlMin = numIn(patch.autoReply.threadTtlMin, 1, 120, a.threadTtlMin ?? 10);
    a.threadMaxMin = numIn(patch.autoReply.threadMaxMin, 0, 240, a.threadMaxMin ?? 0);
    a.dmThreadTtlMin = numIn(patch.autoReply.dmThreadTtlMin, 1, 120, a.dmThreadTtlMin ?? 5);
    if (typeof patch.autoReply.proactiveInGroups === "boolean") a.proactiveInGroups = patch.autoReply.proactiveInGroups;
    a.mentionMergeSec = numIn(patch.autoReply.mentionMergeSec, 5, 300, a.mentionMergeSec ?? 30);
    a.replyGapSec = numIn(patch.autoReply.replyGapSec, 0, 600, a.replyGapSec ?? 45);
    a.threadGapSec = numIn(patch.autoReply.threadGapSec, 5, 300, a.threadGapSec ?? 20);
    a.probeSec = numIn(patch.autoReply.probeSec, 0, 30, a.probeSec ?? 4);
    a.noMentionIntervalMin = numIn(patch.autoReply.noMentionIntervalMin, 5, 240, a.noMentionIntervalMin ?? 30);
    a.maxRepliesPerHour = numIn(patch.autoReply.maxRepliesPerHour, 1, 60, a.maxRepliesPerHour ?? 12);
    const arr = (v) => Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, 50) : [];
    if (Array.isArray(patch.autoReply.mentionKeywords)) a.mentionKeywords = arr(patch.autoReply.mentionKeywords);
    if (Array.isArray(patch.autoReply.whitelistChats)) a.whitelistChats = arr(patch.autoReply.whitelistChats);
  }
  if (patch.multi && typeof patch.multi === "object") {
    const m = out.multi || (out.multi = {});
    if (typeof patch.multi.enabled === "boolean") m.enabled = patch.multi.enabled;
    if (typeof patch.multi.enterBySearch === "boolean") m.enterBySearch = patch.multi.enterBySearch;
    if (Array.isArray(patch.autoReply.proactiveChats)) a.proactiveChats = arr(patch.autoReply.proactiveChats);
    for (const k of ["listScanSec", "perChatCooldownSec", "enterSettleMs", "scrollSampleMs", "scrollStableFrames", "scrollTimeoutMs", "maxScrollScreens"]) {
      if (patch.multi[k] !== undefined) m[k] = numIn(patch.multi[k], 0, 100000, m[k]);
    }
  }
  if (patch.rotation && typeof patch.rotation === "object") {
    const r = out.rotation || (out.rotation = {});
    if (typeof patch.rotation.enabled === "boolean") r.enabled = patch.rotation.enabled;
    r.maxTurns = numIn(patch.rotation.maxTurns, 20, 5000, r.maxTurns ?? 300);
    r.maxSizeMB = numIn(patch.rotation.maxSizeMB, 1, 200, r.maxSizeMB ?? 12);
    r.minAgeMin = numIn(patch.rotation.minAgeMin, 0, 10080, r.minAgeMin ?? 60);
    r.cooldownMin = numIn(patch.rotation.cooldownMin, 1, 10080, r.cooldownMin ?? 30);
    if (typeof patch.rotation.switchSpeakUp === "boolean") r.switchSpeakUp = patch.rotation.switchSpeakUp;
    if (typeof patch.rotation.switchWake === "boolean") r.switchWake = patch.rotation.switchWake;
  }
  if (patch.ocr && typeof patch.ocr === "object") {
    const o = out.ocr || (out.ocr = {});
    const ENGINES = ["windows", "rapidocr", "qwen-vl", "ds-vision"];
    if (ENGINES.includes(patch.ocr.engine)) {
      o.engine = patch.ocr.engine;
      // 直接识图 = 不跑本地 OCR，走整帧路径；切回来时恢复文本差分
      out.mode = patch.ocr.engine === "ds-vision" ? "frame" : "text";
    }
    if (typeof patch.ocr.python === "string" && patch.ocr.python.trim()) o.python = patch.ocr.python.trim();
    if (typeof patch.ocr.vlModel === "string" && patch.ocr.vlModel.trim()) o.vlModel = patch.ocr.vlModel.trim();
    if (typeof patch.ocr.vlUrl === "string" && patch.ocr.vlUrl.trim()) o.vlUrl = patch.ocr.vlUrl.trim();
    o.vlMaxWidth = numIn(patch.ocr.vlMaxWidth, 320, 1080, o.vlMaxWidth ?? 720);
    o.x = numIn(patch.ocr.x, 0, 2000, o.x ?? 0);
    o.y = numIn(patch.ocr.y, 0, 2000, o.y ?? 170);
    o.w = numIn(patch.ocr.w, 100, 4000, o.w ?? 1080);
    o.h = numIn(patch.ocr.h, 100, 4000, o.h ?? 1800);
    const s = Number(patch.ocr.scale);
    if (Number.isFinite(s)) o.scale = Math.min(3, Math.max(1, s));
  }
  if (patch.policy && typeof patch.policy === "object") {
    const p = out.policy;
    p.maxChars = numIn(patch.policy.maxChars, 10, 2000, p.maxChars);
    p.minIntervalMs = numIn(patch.policy.minIntervalMs, 1000, 600000, p.minIntervalMs);
    p.maxPerMinute = numIn(patch.policy.maxPerMinute, 1, 30, p.maxPerMinute);
    p.maxPerHour = numIn(patch.policy.maxPerHour, 1, 500, p.maxPerHour);
    if (Array.isArray(patch.policy.blockPatterns)) {
      p.blockPatterns = patch.policy.blockPatterns
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => s.trim())
        .slice(0, 200);
    }
    if (Array.isArray(patch.policy.allowedChats)) {
      p.allowedChats = patch.policy.allowedChats
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => s.trim())
        .slice(0, 100);
    }
  }
  return out;
}

export function saveConfig(patch) {
  const file = configPath();
  const merged = mergeConfig(loadConfig(file), patch);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return merged;
}

export function autoReplyState(cfg) {
  const file = path.join(dataDir(cfg), "autoreply.json");
  try {
    return { lastReplyAt: 0, lastMentionAt: 0, lastNoMentionAt: 0, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { lastReplyAt: 0, lastMentionAt: 0, lastNoMentionAt: 0 };
  }
}

export function setAutoReplyState(cfg, patch = {}) {
  const file = path.join(dataDir(cfg), "autoreply.json");
  const s = autoReplyState(cfg);
  for (const k of ["lastReplyAt", "lastMentionAt", "lastNoMentionAt"]) {
    if (Number.isFinite(Number(patch[k])) && Number(patch[k]) >= 0) s[k] = Number(patch[k]);
  }
  fs.mkdirSync(dataDir(cfg), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  return s;
}

let cachedConfig = { file: null, mtime: 0, cfg: null };

export function loadConfig(file = configPath()) {
  ensureConfig(file);
  const mtime = fs.statSync(file).mtimeMs;
  if (cachedConfig.file === file && cachedConfig.mtime === mtime) return cachedConfig.cfg;
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cachedConfig = { file, mtime, cfg };
  return cfg;
}

function adb(cfg, args, opts = {}) {
  const out = execFileSync(cfg.adb, ["-s", cfg.serial, ...args], {
    encoding: opts.buffer ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 60000,
    windowsHide: true,
  });
  return opts.buffer ? out : String(out);
}

export function shell(cfg, cmd) {
  return adb(cfg, ["shell", cmd]);
}

export function tap(cfg, x, y) {
  shell(cfg, `input tap ${x} ${y}`);
}

export function key(cfg, code) {
  shell(cfg, `input keyevent ${code}`);
}

export function sleep(ms) {
  execFileSync(process.platform === "win32" ? "ping" : "sleep",
    process.platform === "win32" ? ["-n", String(Math.max(1, Math.round(ms / 1000) + 1)), "127.0.0.1"] : [String(Math.max(1, Math.round(ms / 1000)))],
    { stdio: "ignore" });
}

function dataDir(cfg) {
  const d = cfg.dataDir || path.join(ROOT, "data");
  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(d, "shots"), { recursive: true });
  return d;
}

export function shot(cfg, label = "shot") {
  const dir = path.join(dataDir(cfg), "shots");
  const file = path.join(dir, `${label}-${Date.now()}.png`);
  const buf = adb(cfg, ["exec-out", "screencap", "-p"], { buffer: true, timeout: 30000 });
  fs.writeFileSync(file, buf);
  return file;
}

export function status(cfg) {
  const devices = adb(cfg, ["devices", "-l"]);
  const online = devices.includes(cfg.serial) && devices.includes("device");
  let focus = "", awake = "", wechat = false;
  if (online) {
    focus = (shell(cfg, "dumpsys window | grep mCurrentFocus | head -1") || "").trim();
    awake = (shell(cfg, "dumpsys power | grep mWakefulness") || "").trim();
    wechat = shell(cfg, "pm path com.tencent.mm").includes("package:");
  }
  return { online, focus, awake, wechat, devices: devices.trim() };
}

export function imeOn(cfg) {
  shell(cfg, `ime enable ${cfg.ime.inject}`);
  shell(cfg, `ime set ${cfg.ime.inject}`);
  return (shell(cfg, "settings get secure default_input_method") || "").trim();
}

export function imeOff(cfg) {
  shell(cfg, `ime set ${cfg.ime.default}`);
  shell(cfg, `ime disable ${cfg.ime.inject}`);
  return (shell(cfg, "settings get secure default_input_method") || "").trim();
}

function focusIs(cfg, needle) {
  return shell(cfg, "dumpsys window | grep mCurrentFocus | head -1").includes(needle);
}

/** 回到微信主界面（聊天列表）；必须验证，不能只看 am start */
export function toHome(cfg) {
  for (let i = 0; i < 5; i++) {
    if (focusIs(cfg, "LauncherUI")) return true;
    key(cfg, "KEYCODE_BACK");
    sleep(900);
  }
  return focusIs(cfg, "LauncherUI");
}

/** 通过搜索按标题打开聊天，返回 {opened, screenshot, cleaned}
 *  注意：搜索框会保留上一次的查询，不先清掉就会拼成 "毁灭菇翘嘴软饭群文件传输助手" 这种垃圾串，
 *  第一条结果变成「搜一搜」，点进去是个 webview 页 —— 轮询下一轮又判“不在目标聊天”，于是每 60 秒
 *  重来一次，屏幕上就是反复“切出去→搜索→点进去”。 */
/**
 * 用搜索进入会话（位置无关，不怕列表重排）。
 *
 * ⚠ 这里**不做"进没进去"的判断**：这台微信在会话页里 mCurrentFocus 仍然是 LauncherUI，
 * 以前用 focusIs(ChattingUI) 判定，永远 false，于是每次搜进去又自己按 BACK 退出来。
 * 现在只负责"走完搜索流程"，进没进去交给调用方读标题核对（poller 的 readChatTitle）。
 *
 * @param query 用哪串字去搜；默认取标题前 10 个字（列表 OCR 出来的名字常被省略号截断）
 */
export function openChat(cfg, title, opts = {}) {
  if (!title) throw new Error("openChat 需要聊天标题");
  const query = String(opts.query || title).replace(/[…\.]+$/, "").trim().slice(0, opts.maxLen || 10) || title;
  let on = false;
  try {
    if (!toHome(cfg)) throw new Error("无法回到微信聊天列表（可能停在别的页面或被弹窗挡住）");
    tap(cfg, ...cfg.coords.searchIcon);      // 右上搜索
    sleep(1000);
    if (!focusIs(cfg, "FTS")) throw new Error("没进入微信搜索页");
    tap(cfg, ...cfg.coords.searchField);     // 搜索框
    sleep(400);
    imeOn(cfg); on = true;
    sleep(300);
    // 一次 adb 调用里连按 25 次删除，把上次残留的查询清干净（比 25 次 adb 往返快得多）
    shell(cfg, "for i in $(seq 1 25); do input keyevent 67; done");
    sleep(200);
    shell(cfg, `am broadcast -a ADB_INPUT_TEXT --es msg '${query.replace(/'/g, "'\\''")}'`);
    sleep(1400);
    if (!focusIs(cfg, "FTS")) throw new Error("搜索结果页异常");
    const rfile = shot(cfg, `open-${sanitizeName(title)}`);
    tap(cfg, ...cfg.coords.firstResult);     // 第一个搜索结果（群/聊天）
    sleep(1100);
    return { opened: true, screenshot: rfile, title, query };
  } finally {
    if (on) imeOff(cfg);
  }
}

function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
}

export function watch(cfg, intervalSec = 15, iterations = 5) {
  const frames = [];
  let prev = null;
  for (let i = 0; i < iterations; i++) {
    sleep(intervalSec * 1000);
    const file = shot(cfg, `watch-${i}`);
    const h = regionHash(cfg, file);
    if (prev !== null && h !== prev) frames.push({ file, changed: true });
    else if (prev === null) frames.push({ file, changed: false });
    prev = h;
  }
  return frames;
}

export function frameHash(cfg, png) {
  return regionHash(cfg, png);
}

function regionHash(cfg, png) {
  const ps = path.join(ROOT, "scripts", "hash_region.ps1");
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, png], { encoding: "utf8", windowsHide: true });
  return out.trim().split("\n").pop();
}

export function findSendButton(cfg, png) {
  const ps = path.join(ROOT, "scripts", "find_send.ps1");
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, png], { encoding: "utf8", windowsHide: true });
  const line = out.split("\n").find((l) => l.startsWith("CENTER:"));
  if (!line) return null;
  const [x, y] = line.replace("CENTER:", "").trim().split(",").map(Number);
  return x > 0 && y > 0 ? { x, y } : null;
}

/** 发消息到"当前打开的聊天"；guard 不通过直接拒绝
 *  性能要点（实测）：
 *   - 连按 40 次退格清空草稿 = 40 × 0.5s ≈ 20 秒，换成一条 ADB_CLEAR_TEXT 广播 ≈ 0.13 秒；
 *   - 每个 `adb shell` 在 Windows 上光进程启动就要 ~0.5 秒，所以把「点输入框 + 移光标 + 清空」
 *     压进同一条 shell 里（设备端 sleep），整体从 ~30 秒降到 ~7 秒。 */
export function sendText(cfg, text) {
  const g = guard(cfg, text);
  if (!g.ok) return { sent: false, blocked: true, reasons: g.reasons };
  const rl = rateLimit(cfg);
  if (!rl.ok) return { sent: false, blocked: true, reasons: [rl.reason] };
  imeOn(cfg);
  sleep(250);
  shell(cfg,
    `input tap ${cfg.coords.input[0]} ${cfg.coords.input[1]}; sleep 0.5; ` +
    "input keyevent KEYCODE_MOVE_END; am broadcast -a ADB_CLEAR_TEXT");
  sleep(150);
  shell(cfg, `am broadcast -a ADB_INPUT_TEXT --es msg '${text.replace(/'/g, "'\\''")}'`);
  sleep(400);
  const before = shot(cfg, "pre-send");
  let btn = findSendButton(cfg, before);
  // 找不到绿色按钮时退回配置里固定的发送坐标（早期就是按截图标定的那两个数）。
  // 底色/键盘遮挡都可能让颜色检测失灵，但坐标是不变的。
  if (!btn && Array.isArray(cfg.coords?.send)) {
    btn = { x: Number(cfg.coords.send[0]), y: Number(cfg.coords.send[1]), fixed: true };
  }
  if (!btn) { imeOff(cfg); return { sent: false, blocked: false, reasons: ["找不到发送按钮"], screenshot: before }; }
  tap(cfg, btn.x, btn.y);
  sleep(1100);
  const after = shot(cfg, "post-send");
  // 先收键盘再换输入法：反过来的话偶尔 BACK 会落到聊天页上（键盘已被 imeOff 收走 → BACK 变成"退出聊天"），
  // 于是轮询下一轮判"不在目标聊天"，又去搜索进入一次 —— 屏幕上就是反复切窗口。
  if (shell(cfg, "dumpsys input_method | grep mInputShown=true").includes("true")) {
    key(cfg, "KEYCODE_BACK");
    sleep(400);
  }
  imeOff(cfg);
  recordSend(cfg, text);
  return { sent: true, screenshot: after, button: btn };
}

/* ---------- 策略：主机信息守卫 + 频率限制 ---------- */

export function guard(cfg, text) {
  const reasons = [];
  const t = String(text ?? "");
  if (!t.trim()) reasons.push("内容为空");
  const max = cfg.policy?.maxChars ?? 200;
  if (t.length > max) reasons.push(`超过字数上限 ${max}`);
  for (const pat of cfg.policy?.blockPatterns ?? []) {
    try {
      const re = new RegExp(pat, "i");
      if (re.test(t)) reasons.push(`命中禁止项: ${pat}`);
    } catch { /* 忽略坏正则 */ }
  }
  // 固定高危项，避免配置被删就失去防护
  const hard = [
    /\b\d{1,3}(\.\d{1,3}){3}\b/,
    /[A-Za-z]:[\\/]/,
    /\/c\/Users\//i,
    /\\\\[A-Za-z0-9_.-]+\\/,
    new RegExp(String(cfg.serial || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    /\badb\b/i,
    /platform-tools/i,
    /deepseek\s*harness/i,
    /app\.asar/i,
    /\bdsh\b/i,
  ];
  for (const re of hard) if (re.test(t)) reasons.push(`命中禁止项: ${re.source}`);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function stateFile(cfg) { return path.join(dataDir(cfg), "state.json"); }

function loadState(cfg) {
  try { return JSON.parse(fs.readFileSync(stateFile(cfg), "utf8")); }
  catch { return { sends: [] }; }
}

function saveState(cfg, s) {
  s.sends = (s.sends ?? []).slice(-500);
  fs.writeFileSync(stateFile(cfg), JSON.stringify(s, null, 2));
}

export function rateLimit(cfg) {
  const now = Date.now();
  const s = loadState(cfg);
  const sends = (s.sends ?? []).filter((t) => now - t < 3600_000);
  const minGap = cfg.policy?.minIntervalMs ?? 3000;
  const perMin = cfg.policy?.maxPerMinute ?? 6;
  const perHour = cfg.policy?.maxPerHour ?? 40;
  if (sends.length && now - sends[sends.length - 1] < minGap) return { ok: false, reason: `发送过快（最小间隔 ${minGap}ms）` };
  if (sends.filter((t) => now - t < 60_000).length >= perMin) return { ok: false, reason: `超过每分钟 ${perMin} 条限制` };
  if (sends.length >= perHour) return { ok: false, reason: `超过每小时 ${perHour} 条限制` };
  return { ok: true };
}

function recordSend(cfg, text) {
  const s = loadState(cfg);
  s.sends = [...(s.sends ?? []), Date.now()];
  saveState(cfg, s);
  const audit = path.join(dataDir(cfg), "audit.log");
  const line = JSON.stringify({
    at: new Date().toISOString(),
    textHash: crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16),
    len: String(text).length,
  });
  fs.appendFileSync(audit, line + "\n");
  // 记录最近发出的几条内容，轮询器用它过滤“自己气泡”造成的假新消息。
  // 只记最后一条不够：连着发几条时，前面那些会被 OCR 当成别人发的新消息喂回来。
  try {
    const file = path.join(dataDir(cfg), "last-send.json");
    let prev = [];
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      prev = Array.isArray(j.recent) ? j.recent : (j.text ? [{ text: j.text, at: j.at }] : []);
    } catch { prev = []; }
    const now = Date.now();
    const recent = [...prev, { text: String(text), at: now }]
      .filter((x) => x && x.text && now - Number(x.at || 0) < 15 * 60 * 1000)
      .slice(-12);
    fs.writeFileSync(file, JSON.stringify({ text: String(text), at: now, recent }));
  } catch { /* 写不进去就算了，下一轮再说 */ }
}

/** 最近 ms 内自己发出的文字（用于过滤自触发）；没有则返回空串。 */
export function recentSend(cfg, ms = 180000) {
  const list = recentSends(cfg, ms);
  return list.length ? list[list.length - 1] : "";
}

/** 最近 ms 内自己发过的**所有**文字（过滤自己气泡要用这个，只取最后一条会漏）。 */
/** 最近一次真正发出去的时间（判断"她的回复发出去了没有"）。 */
export function lastSendAt(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir(cfg), "last-send.json"), "utf8"));
    const raw = Array.isArray(j.recent) ? j.recent : (j.text ? [{ text: j.text, at: j.at }] : []);
    return raw.reduce((m, x) => Math.max(m, Number(x.at) || 0), 0);
  } catch {
    return 0;
  }
}

export function recentSends(cfg, ms = 900000) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir(cfg), "last-send.json"), "utf8"));
    const now = Date.now();
    const raw = Array.isArray(j.recent) ? j.recent : (j.text ? [{ text: j.text, at: j.at }] : []);
    return raw
      .filter((x) => x && x.text && now - Number(x.at || 0) < ms)
      .map((x) => String(x.text));
  } catch {
    return [];
  }
}
