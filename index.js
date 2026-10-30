/**
 * dsh-godot-live —— DSH 宿主半区（Node）。
 *
 * 把「运行中的 Godot 游戏画面」接进 DSH Web GUI。
 *
 * 背景：Godot 的 `--headless` 用 dummy 渲染器，`get_texture().get_image()` 返回 null，
 * 所以**截图/看画面必须开真实窗口**。Godot 的 Web 导出又只支持 Compatibility
 * 渲染器且要装 export templates —— 本项目是 Forward+ 且未装模板，走 Web 导出行不通。
 *
 * 本插件的做法：开**原生 Godot 进程**（保持真实渲染器 / GDExtension / autoload 原样），
 * 由 Godot 端 runtime 把视口编成 MJPEG，宿主在 DSH 同源路径上反向代理，
 * 浏览器用 `<img src="...">` 直接显示 —— 不落盘、不占独立端口、不跨域。
 *
 * 路由（全部挂在 DSH 自己的 webServer 上，同源，无 CORS）：
 *   GET  /api/godot-live/status    → 引擎进程状态 + 帧率 + 窗口信息
 *   GET  /api/godot-live/stream    → 反向代理 MJPEG（<img> 直接吃）
 *   GET  /api/godot-live/frame.jpg → 单帧快照（缩略图 / agent 视觉）
 *   POST /api/godot-live/start     → 启动引擎（可选 scene / resolution / fps）
 *   POST /api/godot-live/stop      → 停止引擎
 *   POST /api/godot-live/input     → 注入输入（press / release / tap / click / key）
 *   GET  /api/godot-live/probe     → 当前工作区是不是 Godot 项目（面板显隐用）
 *
 * 模型工具：godot_live_status / godot_live_start / godot_live_stop /
 *           godot_live_input / godot_live_screenshot
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

/** 稳定插件名（与 cordis.patch.yml 的行 id 一致）。 */
export const name = "godot-live";
/** 宿主服务依赖。 */
export const inject = ["webServer", "subprocess", "agents"];

const API = "/api/godot-live";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 记住上次成功启动的项目（可安全删除）。 */
const STATE_FILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "dsh-godot-live.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch { /* 持久化失败不影响功能 */ }
}
/** 随包发布的 Godot 端 runtime 脚本。 */
const RUNTIME_SCRIPT = path.join(HERE, "runtime", "godot_live_stream.gd");

// ── 配置默认值 ─────────────────────────────────────────────────────────────
const DEFAULTS = {
  /** Godot 可执行文件。空 = 自动探测（GODOT 环境变量 / macOS 默认安装路径 / PATH）。 */
  godotBin: "",
  /** 引擎内部串流端口（仅 127.0.0.1）。 */
  streamPort: 8711,
  /** 推流目标帧率。 */
  fps: 20,
  /** 推流宽度（保持纵横比）。0 = 原分辨率。 */
  width: 960,
  /** JPEG 质量。 */
  quality: 0.7,
  /** 启动时窗口分辨率。降低可显著减少抓帧耗时。 */
  resolution: "1280x720",
  /** 启动后把窗口移出屏幕 + 加无边框，尽量不打扰用户。 */
  hideWindow: true,
  /** 主场景覆盖；空 = 读 project.godot。 */
  scene: "",
  /** 固定目标项目；空 = 上次启动的项目 / 工作目录向上找。 */
  projectRoot: "",
  /** 启动引擎的等待上限（毫秒）。 */
  readyTimeoutMs: 20000,
};

// ── 小工具 ─────────────────────────────────────────────────────────────────
function safeGet(ctx, key) {
  try {
    return typeof ctx?.get === "function" ? ctx.get(key) : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 从 base 目录向上找最近的 project.godot；找不到返回 undefined。 */
function findProjectRoot(base) {
  let dir = path.resolve(base);
  for (;;) {
    if (fs.existsSync(path.join(dir, "project.godot"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** 自动探测 Godot 可执行文件。 */
function detectGodot(configured) {
  if (configured && configured.trim() !== "") {
    return fs.existsSync(configured) ? configured : undefined;
  }
  const env = process.env.GODOT;
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    "/Applications/Godot.app/Contents/MacOS/Godot",
    "/Applications/Godot_mono.app/Contents/MacOS/Godot",
    "/usr/local/bin/godot",
    "/opt/homebrew/bin/godot",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 读取 project.godot 里的主场景与项目名（不解析完整 ini，够用即可）。 */
function readProjectMeta(projectRoot) {
  const file = path.join(projectRoot, "project.godot");
  const meta = { name: path.basename(projectRoot), mainScene: "", renderingMethod: "" };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return meta;
  }
  const scene = text.match(/^run\/main_scene="([^"]+)"/m);
  if (scene) meta.mainScene = scene[1];
  const nameLine = text.match(/^config\/name="([^"]+)"/m);
  if (nameLine) meta.name = nameLine[1];
  const renderer = text.match(/^renderer\/rendering_method="([^"]+)"/m);
  const features = text.match(/^config\/features=PackedStringArray\(([^)]*)\)/m);
  meta.renderingMethod = renderer ? renderer[1] : (features ? features[1] : "");
  return meta;
}

/** 对 127.0.0.1 上的 runtime 发一个 HTTP 请求。 */
function runtimeRequest(port, pathname, { method = "GET", body, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(
      typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        timeout: timeoutMs,
        headers: payload
          ? { "content-type": "application/json", "content-length": payload.length }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: buf, text, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("runtime timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 插件主体 ───────────────────────────────────────────────────────────────
export function apply(ctx, rawConfig = {}) {
  const webServer = safeGet(ctx, "webServer");
  const subprocess = safeGet(ctx, "subprocess");
  if (webServer === undefined) {
    throw new Error("dsh-godot-live: 需要 webServer 服务（只在 Web composition 可用）");
  }

  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(rawConfig ?? {})) {
    if (value !== undefined && value !== null) config[key] = value;
  }

  const log = (...args) => console.log("[godot-live]", ...args);

  /** 当前引擎实例。null = 未运行。 */
  let live = null; // { handle, projectRoot, port, startedAt, meta, stderrTail }

  // ── 引擎生命周期 ────────────────────────────────────────────────────────
  /**
   * 目标项目优先级：显式参数 > config.projectRoot > 上次成功启动的项目（持久化）
   * > DSH 默认工作目录向上找 > 进程 cwd 向上找。
   * Desktop 的默认目录通常不是游戏项目，所以「记住上次」对面板按钮很关键。
   */
  function resolveProjectRoot(explicit) {
    if (explicit && explicit.trim() !== "") return path.resolve(explicit);
    if (config.projectRoot && String(config.projectRoot).trim() !== "") {
      return path.resolve(String(config.projectRoot));
    }
    const remembered = readState().lastProjectRoot;
    if (remembered && findProjectRoot(remembered) !== undefined) return remembered;
    const base = safeGet(ctx, "workingDirectory")?.defaultDirectory ?? process.cwd();
    return findProjectRoot(base) ?? findProjectRoot(process.cwd()) ?? path.resolve(base);
  }

  function buildArgs(projectRoot, options) {
    const args = ["--path", projectRoot];
    const resolution = options.resolution ?? config.resolution;
    if (resolution) args.push("--resolution", resolution);
    // hideWindow：移出屏幕 + 无边框，尽量不打扰用户（截图仍能拿到帧）
    if (options.hideWindow ?? config.hideWindow) {
      args.push("--position", "-20000,-20000", "--borderless");
    }
    args.push("--script", RUNTIME_SCRIPT);
    // `--` 之后是 runtime 自己的参数
    args.push("--",
      `--port=${options.port ?? config.streamPort}`,
      `--fps=${options.fps ?? config.fps}`,
      `--width=${options.width ?? config.width}`,
      `--quality=${options.quality ?? config.quality}`);
    const scene = options.scene ?? config.scene;
    if (scene) args.push(`--scene=${scene}`);
    return args;
  }

  async function startEngine(options = {}) {
    if (live !== null) {
      return { ok: true, alreadyRunning: true, ...(await engineStatus()) };
    }
    const bin = detectGodot(config.godotBin);
    if (bin === undefined) {
      throw Object.assign(
        new Error("找不到 Godot 可执行文件。请设置插件 config.godotBin，或环境变量 GODOT。"),
        { code: "godot-not-found" },
      );
    }
    if (!fs.existsSync(RUNTIME_SCRIPT)) {
      throw Object.assign(new Error(`runtime 脚本缺失: ${RUNTIME_SCRIPT}`), { code: "runtime-missing" });
    }
    const projectRoot = resolveProjectRoot(options.projectRoot);
    if (findProjectRoot(projectRoot) === undefined) {
      throw Object.assign(
        new Error(`不是 Godot 项目（目录里没有 project.godot）: ${projectRoot}`),
        { code: "not-godot-project" },
      );
    }
    if (subprocess === undefined) {
      throw new Error("dsh-godot-live: 需要 subprocess 服务来启动 Godot 进程");
    }

    const port = Number(options.port ?? config.streamPort);
    const args = buildArgs(projectRoot, { ...options, port });

    // DSH subprocess 契约（与官方插件一致）：
    //   argv[0] 是可执行文件；stdio 用 collect 收集；graceMs 是 terminate 的宽限；
    //   signal 中止即终止进程树；handle.done 在退出时 resolve；
    //   handle.collected.{stdout,stderr}.readFrom(offset) 读增量输出。
    const abort = new AbortController();
    const handle = subprocess.spawn({
      argv: [bin, ...args],
      cwd: projectRoot,
      env: { DSH_GODOT_LIVE_PORT: String(port) },
      stdio: {
        stdin: "ignore",
        stdout: { collect: { maxBytes: 1024 * 1024 } },
        stderr: { collect: { maxBytes: 1024 * 1024 } },
      },
      graceMs: 3000,
      signal: abort.signal,
    });

    const current = {
      handle,
      abort,
      projectRoot,
      port,
      startedAt: Date.now(),
      meta: readProjectMeta(projectRoot),
      exitCode: null,
    };
    live = current;

    Promise.resolve(handle.done).then(
      (outcome) => {
        current.exitCode = outcome?.exitCode ?? -1;
        log("engine exited", current.exitCode);
        if (live === current) live = null;
      },
      (error) => {
        current.exitCode = -1;
        log("engine failed", String(error?.message ?? error));
        if (live === current) live = null;
      },
    );

    // 等 runtime 真正开始出帧（进程提前退出则立刻失败，不傻等到超时）
    const deadline = Date.now() + config.readyTimeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      if (current.exitCode !== null) {
        lastError = `Godot 进程已退出，exitCode=${current.exitCode}`;
        break;
      }
      try {
        const res = await runtimeRequest(port, "/status", { timeoutMs: 1500 });
        if (res.json?.ok === true) {
          if (res.json.jpeg_bytes > 0) {
            writeState({ lastProjectRoot: projectRoot });
            return { ok: true, started: true, projectRoot, port, engine: res.json, argv: [bin, ...args] };
          }
          lastError = "端口已就绪但还没有帧";
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // 失败：收尸并给出诊断（带 Godot 输出尾部，方便定位根因）
    const tail = readOutputTail(handle);
    terminate(current);
    if (live === current) live = null;
    throw Object.assign(
      new Error(`Godot 启动失败（${lastError || "超时"}）\n输出尾部:\n${tail}`),
      { code: "start-failed" },
    );
  }

  /** 读 collect 缓冲的尾部 2KB。 */
  function readOutputTail(handle) {
    let text = "";
    try {
      text += handle.collected?.stdout?.readFrom(0)?.text ?? "";
      text += handle.collected?.stderr?.readFrom(0)?.text ?? "";
    } catch { /* ignore */ }
    return text.slice(-2000);
  }

  /** 终止一个实例：terminate() 会在 graceMs 后升级为强杀；abort 兜底。 */
  function terminate(instance) {
    try { instance.handle.terminate?.(); } catch { /* ignore */ }
    try { instance.abort.abort(); } catch { /* ignore */ }
  }

  async function stopEngine() {
    if (live === null) return { ok: true, alreadyStopped: true };
    const instance = live;
    live = null;
    terminate(instance);
    // 等它真正退出（最多 graceMs + 1s），保证端口释放后再允许下次启动
    await Promise.race([
      Promise.resolve(instance.handle.done).catch(() => {}),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    return { ok: true, stopped: true, exitCode: instance.exitCode };
  }

  async function engineStatus() {
    if (live === null) {
      return {
        running: false,
        projectRoot: null,
        godotBin: detectGodot(config.godotBin) ?? null,
        runtimeScript: RUNTIME_SCRIPT,
      };
    }
    let engine = null;
    let reachable = false;
    let error = null;
    try {
      const res = await runtimeRequest(live.port, "/status", { timeoutMs: 2000 });
      reachable = res.json?.ok === true;
      engine = res.json ?? null;
    } catch (e) {
      error = String(e?.message ?? e);
    }
    return {
      running: true,
      reachable,
      error,
      projectRoot: live.projectRoot,
      port: live.port,
      uptimeMs: Date.now() - live.startedAt,
      meta: live.meta,
      engine,
      godotBin: detectGodot(config.godotBin) ?? null,
    };
  }

  // ── 路由 ────────────────────────────────────────────────────────────────
  const route = (pathname, method, handler) => ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${API}${pathname}`,
    async handler(req, res) {
      if (req.method !== method) {
        sendJson(res, 405, { ok: false, error: `需要 ${method}` });
        return;
      }
      try {
        await handler({ req, res });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, code: error?.code ?? "error", error: String(error?.message ?? error) });
        } else {
          try { res.end(); } catch { /* ignore */ }
        }
      }
    },
  }), `godot-live: ${method} ${pathname}`);

  route("/status", "GET", async ({ res }) => {
    sendJson(res, 200, await engineStatus());
  });

  route("/probe", "GET", async ({ req, res }) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const dir = url.searchParams.get("path") ?? "";
    // 不带 path：回答「点启动按钮时会用哪个项目」
    const candidate = dir === "" ? resolveProjectRoot(undefined) : dir;
    const projectRoot = findProjectRoot(candidate);
    sendJson(res, 200, {
      ok: true,
      isGodotProject: projectRoot !== undefined,
      projectRoot: projectRoot ?? null,
      meta: projectRoot ? readProjectMeta(projectRoot) : null,
      running: live !== null,
    });
  });

  route("/start", "POST", async ({ req, res }) => {
    const text = await readBody(req);
    const body = text === "" ? {} : JSON.parse(text);
    const result = await startEngine(body ?? {});
    sendJson(res, 200, result);
  });

  route("/stop", "POST", async ({ res }) => {
    sendJson(res, 200, await stopEngine());
  });

  route("/input", "POST", async ({ req, res }) => {
    if (live === null) {
      sendJson(res, 409, { ok: false, error: "引擎未运行" });
      return;
    }
    const text = await readBody(req);
    const body = text === "" ? {} : JSON.parse(text);
    const result = await runtimeRequest(live.port, "/input", { method: "POST", body });
    res.writeHead(result.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(result.buffer);
  });

  // MJPEG 反向代理：把 runtime 的 multipart 流原样透传给浏览器 <img>
  route("/stream", "GET", async ({ req, res }) => {
    if (live === null) {
      sendJson(res, 409, { ok: false, error: "引擎未运行" });
      return;
    }
    const upstream = http.request({
      host: "127.0.0.1",
      port: live.port,
      path: "/",
      method: "GET",
    });
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 200, {
        "content-type": up.headers["content-type"] ?? "multipart/x-mixed-replace; boundary=frame",
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
        connection: "close",
      });
      up.pipe(res);
      up.on("error", () => { try { res.end(); } catch { /* ignore */ } });
    });
    upstream.on("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: `runtime 不可达: ${String(error?.message ?? error)}` });
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
    // 浏览器关掉 <img> / 切面板 → 断开上游，别泄漏连接
    res.on("close", () => { try { upstream.destroy(); } catch { /* ignore */ } });
    upstream.end();
  });

  route("/frame.jpg", "GET", async ({ res }) => {
    if (live === null) {
      sendJson(res, 409, { ok: false, error: "引擎未运行" });
      return;
    }
    const shot = await runtimeRequest(live.port, "/frame.jpg", { timeoutMs: 5000 });
    res.writeHead(shot.status, {
      "content-type": "image/jpeg",
      "cache-control": "no-store",
      "content-length": shot.buffer.length,
    });
    res.end(shot.buffer);
  });

  // ── 模型工具（按会话隔离）─────────────────────────────────────────────
  // 两个踩过的坑：
  //   1. `tools.register` 收的是**注册表形态**：`parameters` 必须已经是 JSON Schema
  //      （顶层 `type: "object"`）。"按属性名组织"的简写只有 `defineTool` 会转换；
  //      直接塞简写会让 schema 顶层 type=null，网关拒收，**所有会话**一起挂。
  //   2. 工具不能挂在全局 `ctx.tools`，否则每个会话（包括非 Godot 项目）都会带上。
  //      这里改成挂在 Agent 作用域：只有工作目录向上能找到 project.godot 的会话才注册。
  const agents = safeGet(ctx, "agents");

  /** 规范化成严格 JSON Schema，并剔除属性上的非标准字段。 */
  function toJsonSchema(schema) {
    const properties = {};
    for (const [key, spec] of Object.entries(schema?.properties ?? {})) {
      const { required: _ignored, ...rest } = spec ?? {};
      properties[key] = rest;
    }
    const out = { type: "object", properties, additionalProperties: false };
    const required = (schema?.required ?? []).filter((key) => key in properties);
    if (required.length > 0) out.required = required;
    return out;
  }

  const TOOL_SPECS = [
    {
      name: "godot_live_status",
      description: "查看 DSH 内嵌 Godot 引擎的实时状态：是否在跑、项目路径、帧率、流分辨率、已服务帧数。",
      schema: {},
      run: async () => engineStatus(),
    },
    {
      name: "godot_live_start",
      description: "启动内嵌 Godot 引擎并在 DSH 面板里实时显示游戏画面。不传 projectRoot 时使用当前会话所在的 Godot 项目。",
      schema: {
        properties: {
          projectRoot: { type: "string", description: "Godot 项目根目录绝对路径（含 project.godot）" },
          scene: { type: "string", description: "主场景覆盖，如 res://scenes/game/game_2_5d.tscn" },
          width: { type: "number", description: "推流宽度像素（默认 960）" },
          fps: { type: "number", description: "推流帧率（默认 20）" },
          resolution: { type: "string", description: "引擎窗口分辨率，如 1280x720（默认）" },
        },
      },
      run: async (input, sessionProjectRoot) => startEngine({
        ...input,
        projectRoot: input.projectRoot ?? sessionProjectRoot,
      }),
    },
    {
      name: "godot_live_stop",
      description: "停止内嵌的 Godot 引擎进程。",
      schema: {},
      run: async () => stopEngine(),
    },
    {
      name: "godot_live_input",
      description: "向运行中的 Godot 游戏注入输入。action=press/release/tap 用 InputMap 动作名；click/move 用视口逻辑坐标；key 用 keycode。",
      schema: {
        properties: {
          action: {
            type: "string",
            enum: ["press", "release", "tap", "click", "move", "key", "actions"],
            description: "输入类型",
          },
          name: { type: "string", description: "InputMap 动作名（press/release/tap 必填）" },
          x: { type: "number", description: "视口 X 坐标（click/move）" },
          y: { type: "number", description: "视口 Y 坐标（click/move）" },
          keycode: { type: "number", description: "Godot keycode（key）" },
          down: { type: "boolean", description: "按下还是抬起（key，默认 true）" },
          duration_ms: { type: "number", description: "自动释放延迟（tap）" },
        },
        required: ["action"],
      },
      run: async (input) => {
        if (live === null) return { ok: false, error: "引擎未运行" };
        const result = await runtimeRequest(live.port, "/input", { method: "POST", body: input });
        return result.json ?? { ok: false, error: result.text };
      },
    },
    {
      name: "godot_live_screenshot",
      description: "抓取当前游戏画面的一帧 JPEG，直接以图片返回给模型做视觉检查；同时落盘到 path，可再用 read_image 打开。",
      schema: {},
      run: async (_input, _projectRoot, agent) => {
        if (live === null) return { ok: false, error: "引擎未运行" };
        const shot = await runtimeRequest(live.port, "/frame.jpg", { timeoutMs: 6000 });
        if (shot.status !== 200) return { ok: false, error: `抓帧失败: HTTP ${shot.status}` };
        const dir = path.join(os.tmpdir(), "dsh-godot-live");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `frame-${Date.now()}.jpg`);
        fs.writeFileSync(file, shot.buffer);
        // 图片必须先存进 DSH 附件库，结果里只放 attachment 引用（和 read_image 一致）。
        // 直接返回内联 base64 的 image 块会写进会话历史，下游 LLM 适配器按
        // block.attachment 取图时会崩，整个会话之后每轮都失败。
        const attachments = safeGet(agent?.ctx, "attachments") ?? safeGet(ctx, "attachments");
        let attachment;
        if (attachments !== undefined && typeof attachments.saveImage === "function") {
          try {
            attachment = await attachments.saveImage({
              data: new Uint8Array(shot.buffer),
              mediaType: "image/jpeg",
              name: path.basename(file),
            });
          } catch (error) {
            log("saveImage failed, falling back to path only:", error?.message ?? error);
          }
        }
        return {
          ok: true,
          path: file,
          bytes: shot.buffer.length,
          ...(attachment !== undefined ? { attachment } : {}),
        };
      },
      render: (_args, value) => {
        if (value?.ok !== true) return [{ type: "text", text: JSON.stringify(value) }];
        const text = { type: "text", text: `Godot 画面已抓取（${value.bytes} 字节），已保存到 ${value.path}` };
        if (value.attachment?.attachmentId === undefined) {
          return [{ ...text, text: `${text.text}。附件库不可用，请用 read_image 打开该路径查看。` }];
        }
        return [text, { type: "image", attachment: value.attachment }];
      },
    },
  ];

  /** 解析会话工作目录对应的 Godot 项目根；不是 Godot 项目返回 undefined。 */
  async function sessionGodotRoot(agent) {
    const wd = safeGet(agent?.ctx, "workingDirectory");
    let cwd;
    try {
      cwd = wd?.get?.(agent.session);
      if ((cwd === undefined || cwd === null) && typeof wd?.ensure === "function") {
        cwd = await wd.ensure(agent, AbortSignal.timeout(5000));
      }
    } catch {
      cwd = undefined;
    }
    if (typeof cwd !== "string" || cwd === "") return undefined;
    return findProjectRoot(cwd);
  }

  /** 在单个 Agent 作用域里注册全部 godot 工具，返回卸载函数。 */
  function installTools(agent, projectRoot) {
    const scopedTools = safeGet(agent.ctx, "tools");
    if (scopedTools === undefined || typeof scopedTools.register !== "function") return undefined;
    const disposers = [];
    try {
      for (const spec of TOOL_SPECS) {
        const dispose = scopedTools.register({
          name: spec.name,
          description: spec.description,
          parameters: toJsonSchema(spec.schema),
          output: {
            schema: { type: "object", additionalProperties: true },
            render: spec.render ?? ((_args, value) => [{ type: "text", text: JSON.stringify(value) }]),
          },
          async execute(input) {
            try {
              return await spec.run(input ?? {}, projectRoot, agent);
            } catch (error) {
              return { ok: false, error: String(error?.message ?? error) };
            }
          },
        });
        if (typeof dispose === "function") disposers.push(dispose);
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      log("tool registration failed; godot tools disabled for this session:", error?.message ?? error);
      return undefined;
    }
    log("tools enabled for session", agent.id, "project =", projectRoot);
    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* ignore */ }
      }
    };
  }

  /** agent -> 卸载函数；pending 用来防止异步探测期间重复安装。 */
  const installed = new Map();
  const pending = new Set();
  async function maybeInstall(agent) {
    if (agent === undefined || installed.has(agent) || pending.has(agent)) return;
    pending.add(agent);
    try {
      const projectRoot = await sessionGodotRoot(agent);
      if (projectRoot === undefined || !pending.has(agent)) return;
      const dispose = installTools(agent, projectRoot);
      if (dispose !== undefined) installed.set(agent, dispose);
    } catch (error) {
      log("session probe failed:", error?.message ?? error);
    } finally {
      pending.delete(agent);
    }
  }

  if (agents !== undefined && typeof agents.list === "function") {
    for (const agent of agents.list()) void maybeInstall(agent);
    ctx.on("agent/created", ({ agent }) => { void maybeInstall(agent); });
    ctx.on("agent/disposed", ({ agent }) => {
      pending.delete(agent);
      installed.get(agent)?.();
      installed.delete(agent);
    });
    ctx.effect(() => () => {
      for (const dispose of installed.values()) dispose();
      installed.clear();
      pending.clear();
    }, "godot-live: scoped tools");
  } else {
    log("agents service unavailable; model tools disabled (panel still works)");
  }

  // 插件卸载 / DSH 退出时收尸，不留孤儿 Godot 进程
  ctx.effect(() => () => {
    if (live !== null) {
      terminate(live);
      live = null;
    }
  }, "godot-live: cleanup");

  log("ready; runtime =", RUNTIME_SCRIPT);
}

export { DEFAULTS as defaultConfig };
