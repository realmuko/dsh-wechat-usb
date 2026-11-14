window.__ModuleLoader__.load({
  id: "dsh-wechat-usb",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots"];

    // 插件自带的本机 API（热重载不丢；也避开宿主 webServer 的路由注册问题）
    const API = "http://127.0.0.1:65470";
    const readJson = async (r) => {
      const t = await r.text();
      try { return JSON.parse(t); }
      catch { throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`); }
    };

    const S = {
      page: { padding: "18px 20px 40px", maxWidth: 760, font: "inherit", color: "inherit", fontSize: 13 },
      h1: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" },
      sub: { opacity: 0.6, margin: "0 0 16px", fontSize: 12, lineHeight: 1.5 },
      group: { border: "1px solid rgba(127,127,127,.22)", borderRadius: 10, padding: "12px 14px", margin: "0 0 12px" },
      groupTitle: { fontSize: 12, fontWeight: 600, opacity: 0.75, margin: "0 0 10px", letterSpacing: 0.2 },
      row: { display: "flex", alignItems: "center", gap: 10, margin: "0 0 8px" },
      label: { width: 128, flex: "none", opacity: 0.8, fontSize: 12 },
      input: {
        flex: 1, minWidth: 0, height: 28, padding: "0 8px", fontSize: 12, font: "inherit",
        color: "inherit", background: "rgba(127,127,127,.10)",
        border: "1px solid rgba(127,127,127,.25)", borderRadius: 7, outline: "none",
      },
      num: { width: 76, height: 28, padding: "0 8px", fontSize: 12, font: "inherit", color: "inherit",
        background: "rgba(127,127,127,.10)", border: "1px solid rgba(127,127,127,.25)", borderRadius: 7, outline: "none" },
      textarea: { width: "100%", minHeight: 74, padding: "6px 8px", fontSize: 12, font: "ui-monospace,Consolas,monospace",
        color: "inherit", background: "rgba(127,127,127,.10)", border: "1px solid rgba(127,127,127,.25)",
        borderRadius: 7, outline: "none", resize: "vertical", boxSizing: "border-box" },
      btn: { height: 30, padding: "0 14px", fontSize: 12, font: "inherit", color: "inherit",
        background: "rgba(127,127,127,.12)", border: "1px solid rgba(127,127,127,.28)", borderRadius: 8, cursor: "pointer" },
      btnPrimary: { height: 30, padding: "0 16px", fontSize: 12, font: "inherit", color: "#fff",
        background: "#2563eb", border: "1px solid #2563eb", borderRadius: 8, cursor: "pointer" },
      note: { fontSize: 11, opacity: 0.55, marginTop: 6, lineHeight: 1.5 },
      msg: (ok) => ({ marginTop: 10, fontSize: 12, color: ok ? "#16a34a" : "#dc2626", whiteSpace: "pre-wrap" }),
    };

    function pair(v) {
      const a = Array.isArray(v) ? v : [0, 0];
      return [Number(a[0]) || 0, Number(a[1]) || 0];
    }

    /** 会话列表里显示用：只要最后一段目录名。 */
    function baseName(p) {
      const s = String(p || "").replace(/[\\/]+$/, "");
      const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
      return i >= 0 ? s.slice(i + 1) : s;
    }

    function relTime(ts) {
      const t = Number(ts || 0);
      if (!t) return "未知时间";
      const m = Math.floor((Date.now() - t) / 60000);
      if (m < 1) return "刚刚";
      if (m < 60) return `${m} 分钟前`;
      const hr = Math.floor(m / 60);
      if (hr < 24) return `${hr} 小时前`;
      return `${Math.floor(hr / 24)} 天前`;
    }

    function Row(props) {
      return h("div", { style: S.row },
        h("span", { style: S.label }, props.label),
        props.children);
    }

    /** 会话轮换：攒够上下文就开新会话 + 搬记忆 + 改绑定。 */
    function RotationPanel(props) {
      const cfg = props.cfg || {};
      const r = cfg.rotation || {};
      const [info, setInfo] = React.useState(null);
      const [note, setNote] = React.useState("");
      const [busy, setBusy] = React.useState(false);

      const load = async () => {
        try {
          const res = await fetch(`${API}/rotate`);
          const j = await readJson(res);
          if (j.ok) setInfo(j);
        } catch { /* 读不到就只显示设置 */ }
      };
      React.useEffect(() => { load(); }, []);

      const spin = async () => {
        setBusy(true);
        try {
          const res = await fetch(`${API}/rotate`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ force: true }),
          });
          const j = await readJson(res);
          setNote(j.ok
            ? (j.to ? `已换到新会话：${String(j.to).slice(0, 22)}…（${j.reason || "手动"}）` : `没有换：${j.error || j.skipped || "未知原因"}`)
            : `失败：${j.error || j.skipped || "未知"}`);
          load();
        } catch (e) {
          setNote("失败：" + e.message);
        } finally {
          setBusy(false);
        }
      };

      const num = (k, d, label) => h(Row, { label },
        h("input", {
          style: S.num, type: "number", value: r[k] ?? d,
          onChange: (e) => props.patch((c) => { c.rotation = { ...(c.rotation || {}), [k]: Number(e.target.value) }; }),
        }));

      const flag = (k, label, hint) => h("label", { style: { display: "flex", gap: 8, alignItems: "flex-start", margin: "0 0 8px", cursor: "pointer" } },
        h("input", {
          type: "checkbox", checked: r[k] !== false, style: { marginTop: 2 },
          onChange: (e) => props.patch((c) => { c.rotation = { ...(c.rotation || {}), [k]: e.target.checked }; }),
        }),
        h("span", {}, h("b", {}, label), hint ? h("br") : null,
          hint ? h("span", { style: { opacity: 0.6, fontSize: 11 } }, hint) : null));

      const st = info && info.stats;
      return h("div", { style: S.group },
        h("div", { style: S.groupTitle }, "会话轮换（攒满上下文就换新会话）"),
        h("label", { style: { display: "flex", gap: 8, alignItems: "flex-start", margin: "0 0 10px", cursor: "pointer" } },
          h("input", {
            type: "checkbox", checked: r.enabled === true, style: { marginTop: 2 },
            onChange: (e) => props.patch((c) => { c.rotation = { ...(c.rotation || {}), enabled: e.target.checked }; }),
          }),
          h("span", {},
            h("b", {}, "开启自动轮换"),
            h("br"),
            h("span", { style: { opacity: 0.65, fontSize: 12 } },
              "只解决「上下文别太长」：当前唤醒会话攒到阈值 → 新建一个会话 → 记忆文件复制过去 → 唤醒会话和主动搭话的目标会话一起改成新的。会话跟微信里的讨论串无关，换不换都不影响她正在聊的那条串。"))),
        num("maxTurns", 300, "最多轮数"),
        num("maxSizeMB", 12, "最多体积（MB）"),
        num("minAgeMin", 60, "最短存活（分）"),
        num("cooldownMin", 30, "两次间隔（分）"),
        flag("switchSpeakUp", "同步改「主动搭话」的目标会话"),
        flag("switchWake", "同步改「唤醒会话」"),
        h("div", { style: S.note },
          st
            ? `当前唤醒会话：${String((info && info.stats && info.stats.file) || "").split(/[\\/]/).slice(-3, -1).join("/") || "?"} · ${st.sizeMB} MB · ${st.turns} 轮 · 已 ${st.ageMin} 分钟`
            : "还没读到当前会话体量（点「刷新体量」试试）"),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 8 } },
          h("button", { style: S.btn, onClick: load, disabled: busy }, "刷新体量"),
          h("button", { style: S.btn, onClick: spin, disabled: busy }, busy ? "处理中…" : "立即换一次")),
        note ? h("div", { style: S.msg(true) }, note) : null);
    }

    function PairEditor(props) {
      const [x, y] = pair(props.value);
      const set = (nx, ny) => props.onChange([nx, ny]);
      return h("span", { style: { display: "flex", gap: 8, flex: 1 } },
        h("input", { style: S.num, type: "number", value: x, onChange: (e) => set(Number(e.target.value), y) }),
        h("input", { style: S.num, type: "number", value: y, onChange: (e) => set(x, Number(e.target.value)) }));
    }

    function WechatUsbSection() {
      const [cfg, setCfg] = React.useState(null);
      const [meta, setMeta] = React.useState({ path: "", mtime: "" });
      const [msg, setMsg] = React.useState({ ok: true, text: "" });
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState("");

      const load = async () => {
        try {
          const r = await fetch(`${API}/config`);
          const j = await readJson(r);
          if (!j.ok) throw new Error(j.error || "load failed");
          setCfg(j.config);
          setMeta({ path: j.path, mtime: new Date(j.mtime).toLocaleString() });
        } catch (e) {
          setMsg({ ok: false, text: "读取配置失败：" + e.message });
        }
      };

      React.useEffect(() => { load(); }, []);

      const patch = (fn) => setCfg((c) => {
        const next = JSON.parse(JSON.stringify(c));
        fn(next);
        return next;
      });

      const save = async () => {
        setBusy(true);
        try {
          const r = await fetch(`${API}/config`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(cfg),
          });
          const j = await readJson(r);
          if (!j.ok) throw new Error(j.error || "save failed");
          setCfg(j.config);
          setMeta((m) => ({ ...m, mtime: new Date().toLocaleString() }));
          setMsg({ ok: true, text: "已保存，下一次工具调用即生效。" });
        } catch (e) {
          setMsg({ ok: false, text: "保存失败：" + e.message });
        } finally {
          setBusy(false);
        }
      };

      const checkStatus = async () => {
        setStatus("检查中…");
        try {
          const r = await fetch(`${API}/status`);
          const j = await readJson(r);
          if (!j.ok) throw new Error(j.error || "status failed");
          const s = j.status;
          setStatus(`online=${s.online} wechat=${s.wechat}\n${s.focus}\n${s.awake}`);
        } catch (e) {
          setStatus("失败：" + e.message);
        }
      };

      const [poll, setPoll] = React.useState(null);
      const [pollBusy, setPollBusy] = React.useState(false);
      const [pollInterval, setPollInterval] = React.useState(15);
      const [zoom, setZoom] = React.useState(null);
      const [sessions, setSessions] = React.useState(null);
      const [sessionsBusy, setSessionsBusy] = React.useState(false);
      const [sessionsErr, setSessionsErr] = React.useState("");

      const loadSessions = async () => {
        setSessionsBusy(true);
        try {
          const r = await fetch(`${API}/sessions`);
          const j = await readJson(r);
          if (!j.ok) throw new Error(j.error || "sessions failed");
          setSessions(j.sessions || []);
          setSessionsErr("");
        } catch (e) {
          setSessionsErr(String(e?.message || e));
        } finally {
          setSessionsBusy(false);
        }
      };

      React.useEffect(() => { loadSessions(); }, []);

      const loadPoll = async () => {
        try {
          const r = await fetch(`${API}/poll`);
          const j = await readJson(r);
          if (j.ok) {
            setPoll(j.status);
            setPollInterval(j.status.intervalSec || 15);
          }
        } catch { /* 状态读不到不影响其他设置 */ }
      };

      React.useEffect(() => { loadPoll(); }, []);

      const pollAction = async (action) => {
        setPollBusy(true);
        try {
          const r = await fetch(`${API}/poll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, intervalSec: Number(cfg.autoReply?.intervalSec ?? pollInterval) }),
          });
          const j = await readJson(r);
          if (!j.ok) throw new Error(j.error || "poll failed");
          setPoll(j.status);
          setMsg({ ok: true, text: action === "start" ? "已启动后台轮询。" : "已停止后台轮询。" });
        } catch (e) {
          setMsg({ ok: false, text: "轮询操作失败：" + e.message });
        } finally {
          setPollBusy(false);
        }
      };

      if (!cfg) return h("div", { style: S.page }, h("p", { style: S.sub }, "加载配置中…"), msg.text ? h("div", { style: S.msg(msg.ok) }, msg.text) : null);

      const coords = cfg.coords || {};
      const policy = cfg.policy || {};
      const engine = cfg.ocr?.engine || "rapidocr";
      const ENGINE_NOTE = {
        rapidocr: "截图 → 本地 RapidOCR 逐行识别 → 只把新增文本行交给模型。最快最省，但读不到图片/表情里的内容，也不区分是谁说的。",
        windows: "同传统 OCR，只是换用 Windows 自带识别；准确率一般，作为没装 RapidOCR 时的兜底。",
        "qwen-vl": "截图 → 本地 Qwen3-VL 4B（走 Ollama）读成「昵称：内容」逐行文本 → 只把新增行交给模型。能读表情包/图片内容、能分说话人，代价是 Ollama 常驻约 3.3GB 显存、每帧约 1 秒。",
        "ds-vision": "不跑本地识别：画面一变就把整帧截图交给唤醒会话，由 DS 自己 read_image 看图。信息最全（表情/引用/排版都看得到），但每条都花图片 token，且没有文本差分。",
      };

      return h("div", { style: S.page },
        h("h1", { style: S.h1 }, "微信 USB"),
        h("p", { style: S.sub },
          "通过 USB + ADB 操作真机微信。改完点保存即可生效，不需要重启。",
          h("br"),
          "配置文件：", meta.path || "（未知）", " · 最后修改：", meta.mtime || "—"),

        h("div", { style: S.group },
          h("div", { style: S.groupTitle }, "设备"),
          h(Row, { label: "ADB 路径" },
            h("input", {
              style: S.input, value: cfg.adb || "",
              onChange: (e) => patch((c) => { c.adb = e.target.value; }),
            })),
          h(Row, { label: "设备序列号" },
            h("input", {
              style: S.input, value: cfg.serial || "",
              onChange: (e) => patch((c) => { c.serial = e.target.value; }),
            })),
          h(Row, { label: "数据目录" },
            h("input", {
              style: S.input, value: cfg.dataDir || "",
              onChange: (e) => patch((c) => { c.dataDir = e.target.value; }),
            })),
          h("div", { style: S.note }, "截图、审计日志、限频状态都写在数据目录里。")),

        h("div", { style: S.group },
          h("div", { style: S.groupTitle }, "消息读取模式"),
          h(Row, { label: "识别引擎" },
            h("select", {
              style: { ...S.input, height: 28 },
              value: engine,
              onChange: (e) => patch((c) => {
                const v = e.target.value;
                c.ocr = { ...(c.ocr || {}), engine: v };
                c.mode = v === "ds-vision" ? "frame" : "text";
              }),
            },
              h("option", { value: "rapidocr" }, "① 传统 OCR · RapidOCR（逐行差分，最快最省）"),
              h("option", { value: "windows" }, "① 传统 OCR · Windows 自带（兜底）"),
              h("option", { value: "qwen-vl" }, "② 本地小模型 · Qwen3-VL 4B（能读图、带说话人）"),
              h("option", { value: "ds-vision" }, "③ 直接 DS 识图（整帧交给模型，不做本地识别）"))),
          engine === "qwen-vl"
            ? h(Row, { label: "小模型名" },
              h("input", {
                style: S.input, value: cfg.ocr?.vlModel || "qwen3-vl:4b-instruct",
                placeholder: "qwen3-vl:4b-instruct",
                onChange: (e) => patch((c) => { c.ocr = { ...(c.ocr || {}), vlModel: e.target.value }; }),
              }))
            : null,
          engine === "qwen-vl"
            ? h(Row, { label: "送图宽度 px" },
              h("input", {
                style: S.num, type: "number", value: cfg.ocr?.vlMaxWidth ?? 720,
                onChange: (e) => patch((c) => { c.ocr = { ...(c.ocr || {}), vlMaxWidth: Number(e.target.value) }; }),
              }))
            : null,
          h("div", { style: S.note }, ENGINE_NOTE[engine] || ENGINE_NOTE.rapidocr),
          h("div", { style: S.note }, "保存后立即生效：不用重启，下一次采集就换引擎；小模型叫不通时会自动退回 RapidOCR（状态里能看到 fallback）。")),

        h("div", { style: S.group },
          h("div", { style: S.groupTitle }, "坐标（1080×2160）"),
          h(Row, { label: "聊天输入框" },
            h(PairEditor, { value: coords.input, onChange: (v) => patch((c) => { c.coords.input = v; }) })),
          h(Row, { label: "绿色发送" },
            h(PairEditor, { value: coords.send, onChange: (v) => patch((c) => { c.coords.send = v; }) })),
          h(Row, { label: "搜索图标" },
            h(PairEditor, { value: coords.searchIcon, onChange: (v) => patch((c) => { c.coords.searchIcon = v; }) })),
          h(Row, { label: "搜索框" },
            h(PairEditor, { value: coords.searchField, onChange: (v) => patch((c) => { c.coords.searchField = v; }) })),
          h(Row, { label: "第一个搜索结果" },
            h(PairEditor, { value: coords.firstResult, onChange: (v) => patch((c) => { c.coords.firstResult = v; }) })),
          h("div", { style: S.note }, "换手机或改分辨率后，用 wechat_shot 截屏按图量坐标再填。")),

        h("div", { style: S.group },
          h("div", { style: S.groupTitle }, "安全限制"),
          h(Row, { label: "单条字数上限" },
            h("input", {
              style: S.num, type: "number", value: policy.maxChars ?? 200,
              onChange: (e) => patch((c) => { c.policy.maxChars = Number(e.target.value); }),
            })),
          h(Row, { label: "最小间隔 ms" },
            h("input", {
              style: S.num, type: "number", value: policy.minIntervalMs ?? 5000,
              onChange: (e) => patch((c) => { c.policy.minIntervalMs = Number(e.target.value); }),
            })),
          h(Row, { label: "每分钟上限" },
            h("input", {
              style: S.num, type: "number", value: policy.maxPerMinute ?? 6,
              onChange: (e) => patch((c) => { c.policy.maxPerMinute = Number(e.target.value); }),
            })),
          h(Row, { label: "每小时上限" },
            h("input", {
              style: S.num, type: "number", value: policy.maxPerHour ?? 40,
              onChange: (e) => patch((c) => { c.policy.maxPerHour = Number(e.target.value); }),
            })),
          h("div", { style: { ...S.label, width: "auto", margin: "10px 0 6px" } }, "发送拦截正则（每行一条）"),
          h("textarea", {
            style: S.textarea, spellCheck: false,
            value: (policy.blockPatterns || []).join("\n"),
            onChange: (e) => patch((c) => { c.policy.blockPatterns = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean); }),
          }),
          h("div", { style: { ...S.label, width: "auto", margin: "10px 0 6px" } }, "允许的会话标题（每行一条，空 = 不限制）"),
          h("textarea", {
            style: S.textarea, spellCheck: false,
            value: (policy.allowedChats || []).join("\n"),
            onChange: (e) => patch((c) => { c.policy.allowedChats = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean); }),
          })),

        h("div", { style: S.group },
          h("div", { style: S.groupTitle }, "自动回复"),
          h("label", { style: { display: "flex", gap: 8, alignItems: "flex-start", margin: "0 0 10px", cursor: "pointer" } },
            h("input", {
              type: "checkbox", checked: Boolean(cfg.autoReply?.enabled),
              style: { marginTop: 2 },
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), enabled: e.target.checked }; }),
            }),
            h("span", {},
              h("b", {}, "开启自动回复（启动轮询 + 回复）"),
              h("br"),
              h("span", { style: { opacity: 0.65, fontSize: 12 } },
                "保存后立即启动轮询；回复由 DSH 定时任务驱动。关闭后保存即停止轮询。"))),
          h(Row, { label: "轮询间隔（秒）" },
            h("input", {
              style: S.num, type: "number", value: cfg.autoReply?.intervalSec ?? 15,
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), intervalSec: Number(e.target.value) }; }),
            })),
          h(Row, { label: "唤醒会话" },
            h("select", {
              style: { ...S.input, height: 28 },
              value: cfg.autoReply?.wakeSessionId || "",
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), wakeSessionId: e.target.value }; }),
            },
              h("option", { value: "" }, "（不选 — 新消息只进 inbox，不唤醒模型）"),
              (sessions || []).map((s) => h("option", { key: s.id, value: s.id },
                `${s.title || s.id.slice(0, 22)} · ${baseName(s.cwd) || "?"} · ${relTime(s.lastAt)}`)),
              cfg.autoReply?.wakeSessionId && !(sessions || []).some((s) => s.id === cfg.autoReply.wakeSessionId)
                ? h("option", { value: cfg.autoReply.wakeSessionId },
                  `${cfg.autoReply.wakeSessionId}（不在会话列表里）`)
                : null)),
          h(Row, { label: "会话 ID" },
            h("input", {
              style: S.input,
              value: cfg.autoReply?.wakeSessionId || "",
              placeholder: "也可以直接粘贴 session-…",
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), wakeSessionId: e.target.value }; }),
            }),
            h("button", { style: S.btn, onClick: loadSessions, disabled: sessionsBusy }, sessionsBusy ? "刷新中…" : "刷新列表")),
          h("div", { style: S.note },
            sessionsErr
              ? `会话列表读取失败：${sessionsErr}`
              : `列表来自本机会话缓存（${sessions ? sessions.length : "…"} 个）。检测到新消息时会唤醒这个会话去处理 inbox。`),
          cfg.autoReply?.enabled && !cfg.autoReply?.wakeSessionId
            ? h("div", { style: { ...S.note, color: "#dc2626" } },
              "自动回复已开启，但还没选唤醒会话：新消息只会进 inbox，不会唤醒模型。")
            : null,
          h(Row, { label: "无@参与间隔（分）" },
            h("input", {
              style: S.num, type: "number", value: cfg.autoReply?.noMentionIntervalMin ?? 30,
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), noMentionIntervalMin: Number(e.target.value) }; }),
            })),
          h(Row, { label: "每小时上限" },
            h("input", {
              style: S.num, type: "number", value: cfg.autoReply?.maxRepliesPerHour ?? 12,
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), maxRepliesPerHour: Number(e.target.value) }; }),
            })),
          h("label", { style: { display: "flex", gap: 8, alignItems: "flex-start", margin: "0 0 10px", cursor: "pointer" } },
            h("input", {
              type: "checkbox", checked: cfg.autoReply?.autoOpen !== false,
              style: { marginTop: 2 },
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), autoOpen: e.target.checked }; }),
            }),
            h("span", {},
              h("b", {}, "不在目标聊天时自动切回来（搜索进入）"),
              h("br"),
              h("span", { style: { opacity: 0.65, fontSize: 12 } },
                "关掉后：前台不是白名单聊天就只是跳过这一轮，不再去「回列表→搜索→点进群」；已经在目标群聊里本来就不会切。连续两次没切成功会退避 5 分钟，避免屏幕上反复抽搐。"))),
          h(Row, { label: "快速探测间隔（秒）" },
            h("input", {
              style: S.num, type: "number", value: cfg.autoReply?.probeSec ?? 4,
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), probeSec: Number(e.target.value) }; }),
            })),
          h("div", { style: S.note },
            "两级轮询：快轮每隔这么久读一次微信的渲染帧计数（约 0.14 秒），没变化就什么都不做；变了才截图+识别。填 0 = 关掉快轮，只按“轮询间隔”走。"),
          h(Row, { label: "讨论串存活（分）" },
            h("input", {
              style: S.num, type: "number", value: cfg.autoReply?.threadTtlMin ?? 10,
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), threadTtlMin: Number(e.target.value) }; }),
            })),
          h(Row, { label: "串内发言间隔（秒）" },
            h("input", {
              style: S.num, type: "number", value: cfg.autoReply?.threadGapSec ?? 20,
              onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), threadGapSec: Number(e.target.value) }; }),
            })),
          h("div", { style: S.note },
            "“讨论串”是插件里的本地状态：有人 @ 你 → 新开一个串（并把 @ 前几句一起带上）；这个串里后面的消息都算接着聊，可以像真人一样再回，只要离上一条满“串内发言间隔”。你把串的存活时间调小，它就更快「忘了这茬」。"),
          h("div", { style: { ...S.label, width: "auto", margin: "10px 0 6px" } }, "@ 关键词（每行一条，命中即必须回）"),          h("textarea", {
            style: S.textarea, spellCheck: false,
            value: (cfg.autoReply?.mentionKeywords || []).join("\n"),
            onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), mentionKeywords: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }; }),
          }),
          h("div", { style: { ...S.label, width: "auto", margin: "10px 0 6px" } }, "白名单聊天（每行一条；空 = 不限制）"),
          h("textarea", {
            style: S.textarea, spellCheck: false,
            value: (cfg.autoReply?.whitelistChats || []).join("\n"),
            onChange: (e) => patch((c) => { c.autoReply = { ...(c.autoReply || {}), whitelistChats: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) }; }),
          }),
          h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginTop: 10 } },
            h("button", { style: S.btn, onClick: () => pollAction("start"), disabled: pollBusy }, "手动启动轮询"),
            h("button", { style: S.btn, onClick: () => pollAction("stop"), disabled: pollBusy }, "停止"),
            h("button", { style: S.btn, onClick: loadPoll, disabled: pollBusy }, "刷新状态")),
          h("div", { style: S.note },
            poll
              ? `running=${poll.running} · mode=${poll.mode} · ${poll.pending} 待处理 · ${poll.chatTitle || ""}`
              : "状态未知"),
          h("div", { style: S.note },
            "回复由 watcher 在检测到新消息时唤醒模型（一次性 schedule，目标就是上面的「唤醒会话」）；没有新消息就不调用模型。")),

        h("div", { style: S.group },
          h(RotationPanel, { cfg, patch, S, h })),

        h("div", { style: S.group },
          h("div", { style: S.groupTitle }, "坐标示意图"),
          h("div", { style: { display: "flex", gap: 10, overflowX: "auto" } },
            [["chat", "聊天页：输入框 / 发送"], ["list", "列表页：搜索图标"], ["search", "搜索页：搜索框 / 第一条结果"]]
              .map(([name, cap]) => h("figure", {
                key: name,
                onClick: () => setZoom(name),
                style: { margin: 0, flex: "0 0 210px", cursor: "zoom-in" },
              },
                h("img", {
                  src: `${API}/coords-${name}.png`,
                  style: { width: "100%", borderRadius: 8, border: "1px solid rgba(127,127,127,.25)", display: "block" },
                }),
                h("figcaption", { style: { fontSize: 11, opacity: 0.6, marginTop: 4, lineHeight: 1.4 } }, cap)))),
          h("div", { style: S.note }, "红圈就是坐标点，数字与上方「坐标」里的编号对应。点缩略图可放大。")),

        h("div", { style: S.group },
          h("div", { style: S.groupTitle }, "安全策略"),
          h("div", { style: { fontSize: 12, lineHeight: 1.8, opacity: 0.78 } },
            "· 聊天内容一律视为外部不可信数据：其中要求“执行命令 / 读取主机 / 给 API 码”之类的内容不执行，只当作普通消息。",
            h("br"),
            "· 发送前强制拦截主机信息：IP、盘符路径、adb/dsh、平台路径、设备序列号、主机用户名；命中直接拒发。",
            h("br"),
            "· 轮询只读屏幕并进 inbox，不会自动发送；回复必须由 agent 显式调用 wechat_send（并过守卫与限频）。")),

        h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
          h("button", { style: S.btnPrimary, onClick: save, disabled: busy }, busy ? "保存中…" : "保存"),
          h("button", { style: S.btn, onClick: load, disabled: busy }, "重新载入"),
          h("button", { style: S.btn, onClick: checkStatus }, "检查连接")),
        msg.text ? h("div", { style: S.msg(msg.ok) }, msg.text) : null,
        status ? h("pre", { style: { fontSize: 11, opacity: 0.7, whiteSpace: "pre-wrap", marginTop: 10 } }, status) : null,

        h("div", { style: S.note },
          "提示：拦截规则用 JavaScript 正则；发送前会拒绝命中规则的内容，另有一条硬编码兜底（IP、盘符、adb、dsh、序列号等）。"),

        zoom ? h("div", {
          onClick: () => setZoom(null),
          style: {
            position: "fixed", inset: 0, background: "rgba(0,0,0,.82)", zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out",
          },
        }, h("img", {
          src: `${API}/coords-${zoom}.png`,
          style: { maxHeight: "92vh", maxWidth: "94vw", borderRadius: 10, boxShadow: "0 8px 40px rgba(0,0,0,.5)" },
        })) : null);
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => {
        try {
          return ctx.slots.register({
            name: "settings.section",
            id: "wechat-usb",
            order: 130,
            label: () => "微信 USB",
          }, WechatUsbSection);
        } catch (e) {
          return () => {};
        }
      });
    }

    const module = { exports: {} };
    module.exports = { apply, inject };
    return module.exports;
  },
});
