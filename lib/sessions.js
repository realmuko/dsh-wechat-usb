/**
 * 列出本机 DSH 会话，供设置页的「唤醒会话」下拉选择。
 *
 * 数据来源：DSH 的会话投影缓存 `~/.dsh/storages/session_projcache/sessions/*.json`
 * （每个会话一个 JSON，含 title / workingDirectory / sessionListMetadata）。
 * 只读；读不到就退回按 `~/.dsh/sessions/*` 目录列出会话 id（没有标题）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

const CACHE_DIR = () => path.join(dshHome(), "storages", "session_projcache", "sessions");
const SESSIONS_DIR = () => path.join(dshHome(), "sessions");

const isSessionFile = (f) => /^session-[0-9a-f-]+\.json$/.test(f);

function fromCache() {
  const dir = CACHE_DIR();
  let files;
  try { files = fs.readdirSync(dir).filter(isSessionFile); } catch { return null; }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const rows = j?.record?.rows || {};
      const val = (k) => rows[k]?.val;
      const meta = val("sessionListMetadata") || {};
      if (meta.blank) continue; // 空白会话不列
      const identity = j?.record?.identity || {};
      out.push({
        id: f.slice(0, -".json".length),
        title: typeof val("title") === "string" ? val("title").trim() : "",
        cwd: typeof val("workingDirectory") === "string" ? val("workingDirectory") : (identity.cwd || ""),
        createdAt: Number(identity.createdAt) || 0,
        lastAt: Number(meta.lastPromptAt) || Number(identity.createdAt) || 0,
      });
    } catch { /* 单个文件坏了不影响其它会话 */ }
  }
  return out;
}

/** 投影缓存不可用时的兜底：按目录列出会话 id。 */
function fromDirs() {
  const base = SESSIONS_DIR();
  let workspaces = [];
  try { workspaces = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  const out = [];
  for (const w of workspaces) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(base, w.name), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      if (!/^session-/.test(d.name)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(path.join(base, w.name, d.name)).mtimeMs; } catch { /* ignore */ }
      out.push({ id: d.name, title: "", cwd: "", createdAt: 0, lastAt: mtime });
    }
  }
  return out;
}

/** 按最近活动倒序返回会话：{ id, title, cwd, createdAt, lastAt } */
export function listSessions({ limit = 200 } = {}) {
  const cached = fromCache();
  const all = cached && cached.length ? cached : fromDirs();
  // 同一会话可能出现在多个工作区目录里，按 id 去重并保留 lastAt 更大的那条
  const byId = new Map();
  for (const s of all) {
    const prev = byId.get(s.id);
    if (!prev || s.lastAt > prev.lastAt) byId.set(s.id, s);
  }
  return [...byId.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
}
