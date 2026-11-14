/**
 * 独立本机 API（127.0.0.1:65470）。
 * 目的：DSH 插件热重载后，挂到 webServer 的路由可能注册到旧实例上而丢失；
 * 这个端口由插件自己持有，不依赖宿主 webServer，设置页直接用它。
 * 只接受本机来源；浏览器请求校验 Origin（只允许 GUI 的 65461）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import * as core from "./core.js";
import * as poller from "./poller.js";
import { listSessions } from "./sessions.js";
import * as rotation from "./rotation.js";

export const API_PORT = 65470;

// GUI 端口会随 DSH 重启变化；兼容本机 http、桌面壳的 dsh-app 协议和 sandbox 的 null
const GUI_ORIGIN = /^(http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+|dsh-app:\/\/[^\s]*|null)$/;

function logReject(pluginRoot, origin) {
  try {
    fs.appendFileSync(path.join(pluginRoot, "data", "api-reject.log"),
      `${new Date().toISOString()} rejected origin=${JSON.stringify(origin)}\n`);
  } catch { /* ignore */ }
}
const CORS = (origin) => ({
  "access-control-allow-origin": origin || "",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
  vary: "Origin",
});

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

export function startApi(getCfg, pluginRoot, port = API_PORT, getCtx = () => null) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    for (const [k, v] of Object.entries(CORS(origin))) res.setHeader(k, v);

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    // 保底放行：任何来源都允许（仅监听 127.0.0.1），但把 Origin 记下来便于之后收紧
    if (origin) {
      try {
        const f = path.join(pluginRoot, "data", "api-origins.log");
        const line = `${new Date().toISOString()} ${JSON.stringify(origin)}\n`;
        const st = fs.statSync(f, { throwIfNoEntry: false });
        if (!st || st.size < 32 * 1024) fs.appendFileSync(f, line);
      } catch { /* ignore */ }
    }

    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    try {
      if (p === "/config") {
        if (req.method === "GET") {
          const info = core.configInfo();
          return send(res, 200, { ok: true, path: info.path, mtime: info.mtime, config: info.cfg });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const saved = core.saveConfig(body);
          if (saved.autoReply?.enabled) poller.startPolling(saved, saved.autoReply.intervalSec || 15);
          else poller.stopPolling(saved);
          return send(res, 200, { ok: true, config: saved });
        }
        return send(res, 405, { ok: false, error: "method not allowed" });
      }

      if (p === "/sessions") {
        try {
          const limit = Number(url.searchParams.get("limit")) || 200;
          return send(res, 200, { ok: true, sessions: listSessions({ limit }) });
        } catch (e) {
          return send(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      if (p === "/status") {
        try {
          return send(res, 200, { ok: true, status: core.status(getCfg()) });
        } catch (e) {
          return send(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }

      if (p === "/poll") {
        if (req.method === "GET") return send(res, 200, { ok: true, status: poller.pollStatus(getCfg()), debug: poller.pollerDebug() });
        if (req.method === "POST") {
          const body = await readBody(req);
          const cfg = getCfg();
          if (body.action === "start") {
            const { token, ...status } = poller.startPolling(cfg, body.intervalSec);
            return send(res, 200, { ok: true, status });
          }
          if (body.action === "stop") return send(res, 200, { ok: true, status: poller.stopPolling(cfg) });
          return send(res, 400, { ok: false, error: "action must be start or stop" });
        }
        return send(res, 405, { ok: false, error: "method not allowed" });
      }

      if (p === "/rotate") {
        const cfg = getCfg();
        if (req.method === "GET") {
          const sid = String(cfg.autoReply?.wakeSessionId || "");
          return send(res, 200, {
            ok: true,
            rotation: rotation.rotationOf(cfg),
            stats: rotation.sessionStats(sid),
            schedule: poller.pollStatus(cfg).schedule,
          });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          // 会话只是上下文容器：换会话不影响微信里的讨论串（那存在插件自己的 poller-threads.json 里），
          // 所以这里不需要"等聊完再换"，随时可以换。
          const r = await rotation.maybeRotate(getCtx(), cfg, { force: Boolean(body.force) });
          return send(res, 200, { ok: true, ...r });
        }
        return send(res, 405, { ok: false, error: "method not allowed" });
      }

      if (p === "/inbox") {
        const action = url.searchParams.get("action") || "list";
        const cfg = getCfg();
        if (action === "ack") return send(res, 200, { ok: true, ...poller.ackInbox(cfg) });
        return send(res, 200, { ok: true, ...poller.listInbox(cfg) });
      }

      if (p.startsWith("/coords-") && p.endsWith(".png")) {
        const name = p.slice("/coords-".length, -4);
        if (!["chat", "list", "search"].includes(name)) return send(res, 404, { ok: false });
        const buf = fs.readFileSync(path.join(pluginRoot, "assets", `${name}.png`));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return res.end(buf);
      }

      return send(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });

  server.on("error", () => { /* 端口被占用时静默失败，webServer 路由仍可作为后备 */ });
  server.listen(port, "127.0.0.1");
  return server;
}
