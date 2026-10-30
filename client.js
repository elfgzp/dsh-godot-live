/**
 * dsh-godot-live —— 浏览器半区。
 *
 * 注册两个座位：
 *   - `sidebar.panellist`：左侧栏图标入口
 *   - `main`：主列面板，里面是**实时游戏画面**
 *
 * 画面来源：`<img src="/api/godot-live/stream">` —— 同源 MJPEG。
 * 浏览器原生支持 multipart/x-mixed-replace，所以不需要 canvas、不需要解码、
 * 不需要 WebSocket，一个 <img> 标签就够。这也是本插件能极简的原因。
 *
 * 样式全部走宿主主题 token（`--dsw-alias-*`），浅色/深色自动跟随。
 */

window.__ModuleLoader__.load({
  id: "dsh-godot-live",
  factory(require) {
    const React = require("react");

    /** 侧栏与主面板共用的 cell key。 */
    const PANEL_KEY = "godot-live";
    /** 宿主路由前缀。 */
    const API = "/api/godot-live";
    /** 语言命名空间。 */
    const NS = "godot-live";

    const DICTS = {
      zh: {
        "nav.label": "Godot",
        "panel.title": "Godot 实时画面",
        "panel.subtitle": "内嵌原生渲染，无需导出",
        "status.stopped": "未运行",
        "status.starting": "启动中…",
        "status.running": "运行中",
        "status.error": "出错",
        "action.start": "启动引擎",
        "action.stop": "停止",
        "action.restart": "重启",
        "action.snapshot": "抓帧",
        "action.fullscreen": "全屏",
        "action.exitFullscreen": "退出全屏",
        "empty.title": "还没有运行中的 Godot",
        "empty.hint": "点「启动引擎」，或者让 agent 调用 godot_live_start。插件会自动从当前工作区向上找 project.godot。",
        "empty.notProject": "当前工作区不是 Godot 项目（目录里没有 project.godot）",
        "meta.project": "项目",
        "meta.fps": "推流帧率",
        "meta.size": "画面尺寸",
        "meta.uptime": "运行时长",
        "meta.capture": "抓帧耗时",
        "meta.scene": "主场景",
        "input.title": "输入注入",
        "input.hint": "点下面按钮给游戏发输入；也可以用 agent 调 godot_live_input。",
        "error.noEngine": "引擎未运行",
      },
      en: {
        "nav.label": "Godot",
        "panel.title": "Godot Live View",
        "panel.subtitle": "Native rendering, no export needed",
        "status.stopped": "Stopped",
        "status.starting": "Starting…",
        "status.running": "Running",
        "status.error": "Error",
        "action.start": "Start engine",
        "action.stop": "Stop",
        "action.restart": "Restart",
        "action.snapshot": "Snapshot",
        "action.fullscreen": "Fullscreen",
        "action.exitFullscreen": "Exit fullscreen",
        "empty.title": "No Godot running yet",
        "empty.hint": "Click “Start engine”, or have the agent call godot_live_start. The plugin walks up from the current workspace to find project.godot.",
        "empty.notProject": "This workspace is not a Godot project (no project.godot)",
        "meta.project": "Project",
        "meta.fps": "Stream FPS",
        "meta.size": "Frame size",
        "meta.uptime": "Uptime",
        "meta.capture": "Capture cost",
        "meta.scene": "Main scene",
        "input.title": "Input injection",
        "input.hint": "Click a button to send input; the agent can also call godot_live_input.",
        "error.noEngine": "Engine not running",
      },
    };

    // ── 样式（走宿主主题 token）────────────────────────────────────────────
    function installStyles() {
      if (typeof document === "undefined") return () => {};
      const STYLE_ID = "dsh-godot-live-style";
      if (document.getElementById(STYLE_ID) !== null) return () => {};
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = `
        .glv-root{display:flex;flex-direction:column;height:100%;min-height:0;
          gap:12px;padding:16px;box-sizing:border-box;
          color:var(--dsw-alias-label-primary,#e5e5e5);}
        .glv-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex:0 0 auto;}
        .glv-title{font-size:15px;font-weight:600;line-height:1.3;}
        .glv-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6);margin-top:2px;}
        .glv-spacer{flex:1 1 auto;}
        .glv-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;
          padding:3px 9px;border-radius:999px;
          background:var(--dsw-alias-bg-secondary,rgba(255,255,255,.06));
          border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.1));}
        .glv-dot{width:7px;height:7px;border-radius:50%;background:#8b8f96;}
        .glv-dot.running{background:#3ecf8e;}
        .glv-dot.starting{background:#e8b339;}
        .glv-dot.error{background:#e5534b;}
        .glv-btn{font:inherit;font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer;
          color:var(--dsw-alias-label-primary,#e5e5e5);
          background:var(--dsw-alias-bg-secondary,rgba(255,255,255,.06));
          border:1px solid var(--dsw-alias-border-primary,rgba(255,255,255,.16));}
        .glv-btn:hover:not(:disabled){background:var(--dsw-alias-bg-tertiary,rgba(255,255,255,.1));}
        .glv-btn:disabled{opacity:.45;cursor:not-allowed;}
        .glv-btn.primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff;}
        .glv-stage{position:relative;flex:1 1 auto;min-height:0;border-radius:10px;overflow:hidden;
          background:#0a0a0c;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.1));
          display:flex;align-items:center;justify-content:center;}
        .glv-stage:focus{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px;}
        .glv-stage img{max-width:100%;max-height:100%;width:auto;height:auto;
          image-rendering:auto;display:block;}
        .glv-stage canvas{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;}
        .glv-empty{text-align:center;padding:24px;max-width:520px;}
        .glv-empty h3{margin:0 0 8px;font-size:15px;font-weight:600;}
        .glv-empty p{margin:0;font-size:13px;line-height:1.6;
          color:var(--dsw-alias-label-secondary,#9aa0a6);}
        .glv-meta{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;flex:0 0 auto;
          color:var(--dsw-alias-label-secondary,#9aa0a6);}
        .glv-meta b{display:block;font-weight:600;font-size:12px;margin-top:1px;
          color:var(--dsw-alias-label-primary,#e5e5e5);}
        .glv-err{font-size:12px;color:#e5534b;white-space:pre-wrap;word-break:break-word;
          max-height:110px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
        .glv-keys{display:flex;gap:6px;flex-wrap:wrap;flex:0 0 auto;}
        .glv-full{position:fixed;inset:0;z-index:9999;background:#000;padding:0;border-radius:0;border:none;}
        .glv-full img{max-width:100vw;max-height:100vh;}
      `;
      document.head.appendChild(el);
      return () => { el.remove(); };
    }

    // ── 面板 ───────────────────────────────────────────────────────────────
    function GodotPanel(props) {
      // props.locale → 翻译函数由宿主注入；这里再兜一层，保证单独渲染也不炸
      const t = props.t ?? ((key) => DICTS.zh[key] ?? key);

      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const [full, setFull] = React.useState(false);
      const [streamKey, setStreamKey] = React.useState(0);
      const [probe, setProbe] = React.useState(null);
      const imgRef = React.useRef(null);
      const stageRef = React.useRef(null);

      const refresh = React.useCallback(async () => {
        try {
          const res = await fetch(`${API}/status`, { cache: "no-store" });
          const json = await res.json();
          setStatus(json);
          if (json?.running === false) setError("");
        } catch (e) {
          setStatus({ running: false, reachable: false, error: String(e) });
        }
      }, []);

      const probeWorkspace = React.useCallback(async () => {
        try {
          // 宿主侧从 DSH 默认工作目录向上找 project.godot
          const res = await fetch(`${API}/probe`, { cache: "no-store" });
          setProbe(await res.json());
        } catch {
          setProbe(null);
        }
      }, []);

      // 挂载后轮询状态（画面本身是 <img> 自流的，不需要轮询）
      React.useEffect(() => {
        refresh();
        probeWorkspace();
        const id = setInterval(refresh, 2500);
        return () => clearInterval(id);
      }, [refresh, probeWorkspace]);

      const post = React.useCallback(async (path, body) => {
        setBusy(true);
        setError("");
        try {
          const res = await fetch(`${API}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
          });
          const json = await res.json();
          if (json?.ok === false) setError(json.error ?? "unknown error");
          await refresh();
          return json;
        } catch (e) {
          setError(String(e));
          return null;
        } finally {
          setBusy(false);
        }
      }, [refresh]);

      const start = React.useCallback(() => {
        setStreamKey((k) => k + 1);
        return post("/start", {});
      }, [post]);

      const stop = React.useCallback(() => post("/stop", {}), [post]);

      const snapshot = React.useCallback(async () => {
        try {
          const res = await fetch(`${API}/frame.jpg?t=${Date.now()}`, { cache: "no-store" });
          if (!res.ok) {
            setError(`抓帧失败 HTTP ${res.status}`);
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `godot-frame-${Date.now()}.jpg`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        } catch (e) {
          setError(String(e));
        }
      }, []);

      // 点击画面 → 换算成视口逻辑坐标后注入
      const onStageClick = React.useCallback(async (ev) => {
        const img = imgRef.current;
        if (img === null || status?.running !== true) return;
        const rect = img.getBoundingClientRect();
        const vw = status?.engine?.viewport?.[0] ?? status?.engine?.stream_size?.[0] ?? rect.width;
        const vh = status?.engine?.viewport?.[1] ?? status?.engine?.stream_size?.[1] ?? rect.height;
        const x = ((ev.clientX - rect.left) / rect.width) * vw;
        const y = ((ev.clientY - rect.top) / rect.height) * vh;
        await post("/input", { action: "click", x: Math.round(x), y: Math.round(y) });
      }, [post, status]);

      // 键盘透传：点一下画面获得焦点后，按键 → 游戏 InputMap 动作。
      const KEYMAP = {
        KeyW: "move_up", ArrowUp: "move_up",
        KeyS: "move_down", ArrowDown: "move_down",
        KeyA: "move_left", ArrowLeft: "move_left",
        KeyD: "move_right", ArrowRight: "move_right",
        KeyE: "equip", KeyF: "interact", Tab: "cavity", Escape: "pause",
        Space: "ui_accept", Enter: "ui_accept",
      };
      const held = React.useRef(new Set());
      const sendAction = (action, name) => fetch(`${API}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, name }),
      }).catch(() => {});
      const sendKey = React.useCallback((ev, down) => {
        if (status?.running !== true) return;
        const name = KEYMAP[ev.code];
        if (!name) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (down) {
          if (held.current.has(name)) return; // 忽略键盘自动重复
          held.current.add(name);
        } else {
          held.current.delete(name);
        }
        sendAction(down ? "press" : "release", name);
      }, [status]);
      // 失焦时松开所有按住的键，避免角色一直走
      const releaseAll = React.useCallback(() => {
        for (const name of held.current) sendAction("release", name);
        held.current.clear();
      }, []);

      const running = status?.running === true;
      const reachable = status?.reachable === true;
      const engine = status?.engine ?? null;
      const phase = busy ? "starting" : running ? (reachable ? "running" : "error") : "stopped";

      const phaseText = {
        stopped: t("status.stopped"),
        starting: t("status.starting"),
        running: t("status.running"),
        error: t("status.error"),
      }[phase];

      const actions = [];
      if (!running) {
        actions.push(React.createElement("button", {
          key: "start", className: "glv-btn primary", onClick: start, disabled: busy,
        }, t("action.start")));
      } else {
        actions.push(React.createElement("button", {
          key: "stop", className: "glv-btn", onClick: stop, disabled: busy,
        }, t("action.stop")));
      }
      actions.push(React.createElement("button", {
        key: "snap", className: "glv-btn", onClick: snapshot, disabled: !running,
      }, t("action.snapshot")));
      actions.push(React.createElement("button", {
        key: "full", className: "glv-btn", onClick: () => setFull((v) => !v), disabled: !running,
      }, full ? t("action.exitFullscreen") : t("action.fullscreen")));

      const stage = React.createElement("div", {
        className: full ? "glv-stage glv-full" : "glv-stage",
        ref: stageRef,
        tabIndex: 0,
        title: "点击画面获得焦点后，WASD / 方向键 / E / F / Tab / Esc 会直接发给游戏",
        onClick: (ev) => { stageRef.current?.focus(); onStageClick(ev); },
        onKeyDown: (ev) => sendKey(ev, true),
        onKeyUp: (ev) => sendKey(ev, false),
        onBlur: releaseAll,
      },
      running && reachable
        ? React.createElement("img", {
            key: streamKey,
            ref: imgRef,
            src: `${API}/stream?t=${streamKey}`,
            alt: "Godot live view",
            onError: () => {
              // MJPEG 连接断了（引擎重启/退出）：延迟后重连一次
              setTimeout(() => setStreamKey((k) => k + 1), 1200);
            },
          })
        : React.createElement("div", { className: "glv-empty" },
            React.createElement("h3", null, t("empty.title")),
            React.createElement("p", null,
              probe !== null && probe.isGodotProject === false
                ? t("empty.notProject")
                : t("empty.hint"))));

      // 游戏输入动作：从 /status 拿不到，单独问一次（懒加载，失败静默）
      return React.createElement("div", { className: "glv-root" },
        React.createElement("div", { className: "glv-head" },
          React.createElement("div", null,
            React.createElement("div", { className: "glv-title" }, t("panel.title")),
            React.createElement("div", { className: "glv-sub" }, t("panel.subtitle"))),
          React.createElement("div", { className: "glv-spacer" }),
          React.createElement("span", { className: "glv-chip" },
            React.createElement("span", { className: `glv-dot ${phase}` }),
            phaseText),
          ...actions),
        error !== "" ? React.createElement("div", { className: "glv-err" }, error) : null,
        stage,
        React.createElement("div", { className: "glv-meta" },
          React.createElement("div", null, t("meta.project"),
            React.createElement("b", null, status?.meta?.name ?? status?.projectRoot ?? "—")),
          React.createElement("div", null, t("meta.fps"),
            React.createElement("b", null, engine ? `${engine.frames_served ?? 0} served / ${engine.target_fps ?? "?"} target` : "—")),
          React.createElement("div", null, t("meta.size"),
            React.createElement("b", null, engine?.stream_size ? `${engine.stream_size[0]}×${engine.stream_size[1]}` : "—")),
          React.createElement("div", null, t("meta.capture"),
            React.createElement("b", null, engine?.capture_ms != null ? `${engine.capture_ms.toFixed(1)} ms` : "—")),
          React.createElement("div", null, t("meta.scene"),
            React.createElement("b", null, engine?.scene ?? status?.meta?.mainScene ?? "—"))));
    }

    // ── 侧栏图标 ───────────────────────────────────────────────────────────
    function SidebarIcon(props) {
      const size = props?.size ?? 18;
      // 手柄造型，跟「插件 / 自动化任务」的线性图标风格一致
      return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", strokeWidth: 1.7,
        strokeLinecap: "round", strokeLinejoin: "round",
      },
      React.createElement("rect", { x: 2, y: 7, width: 20, height: 10, rx: 5 }),
      React.createElement("line", { x1: 7, y1: 10, x2: 7, y2: 14 }),
      React.createElement("line", { x1: 5, y1: 12, x2: 9, y2: 12 }),
      React.createElement("circle", { cx: 16, cy: 11, r: 1.1, fill: "currentColor", stroke: "none" }),
      React.createElement("circle", { cx: 18.5, cy: 13.5, r: 1.1, fill: "currentColor", stroke: "none" }));
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(installStyles, "godot-live: stylesheet");
        ctx.effect(() => ctx.locale.register(NS, "zh", DICTS.zh), "godot-live: dict zh");
        ctx.effect(() => ctx.locale.register(NS, "en", DICTS.en), "godot-live: dict en");

        // 侧栏入口
        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_KEY,
          order: 30,
          label: () => (ctx.locale.getLocale?.()?.id === "en"
            ? DICTS.en["nav.label"]
            : DICTS.zh["nav.label"]),
          locale: NS,
        }, SidebarIcon));

        // 主列面板
        ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: PANEL_KEY,
          locale: NS,
        }, GodotPanel));
      },
    };
  },
});
