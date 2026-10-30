# dsh-godot-live

把**运行中的 Godot 游戏画面**接进 DeepSeek Harness 的 Web GUI —— 一个面板实时看画面、
注入输入、让 agent 用工具直接"看"和"玩"你的游戏。

> 为什么不是 Web 导出：Godot 的 Web 导出只支持 **Compatibility** 渲染器，且要装
> export templates。Forward+ 项目（比如 2.5D / 3D 游戏）走不通这条路。
>
> 为什么不是 headless：`--headless` 用 dummy 渲染器，
> `get_texture().get_image()` 返回 `null` —— 拿不到画面。
>
> 本插件的做法：开**原生 Godot 进程**（渲染器、GDExtension、autoload 全部保持原样），
> Godot 端把视口编成 MJPEG，DSH 宿主反代到同源路径，浏览器一个 `<img>` 标签就能显示。

## 效果

- 侧栏多一个「游戏」图标 → 点开是主面板，里面是**实时游戏画面**（默认 20fps / 960 宽）
- 面板上可以启动 / 停止 / 抓帧 / 全屏
- 点画面 → 把点击注入游戏（自动换算视口逻辑坐标）
- Agent 有 5 个工具：`godot_live_status` / `godot_live_start` / `godot_live_stop` /
  `godot_live_input` / `godot_live_screenshot`

## 实测数据（M 系 Mac，1280x720 窗口 → 960x540 推流）

| 项目 | 数值 |
|------|------|
| 抓帧 `get_image()` | 0.95 ~ 4.7 ms |
| JPEG 编码 | 5.6 ~ 9.5 ms |
| 每帧大小 | ~40 KB |
| 可达帧率 | 150 fps（960x540）/ 70 fps（1280x720）/ 35 fps（1920x1080）|

默认 20fps 时 CPU 占用很低。

## 安装

```sh
dsh plugin --profile <profile> add /path/to/dsh-godot-live
```

或手动装进 profile：把本目录加进 `package.json` 的 `dependencies`，
并在 `dsh.profile.bundles` 里加上 `dsh-godot-live`。

装完重启 DSH。

## 配置

见 `cordis.patch.yml`，常用项：

| 键 | 默认 | 说明 |
|----|------|------|
| `godotBin` | 自动探测 | Godot 可执行文件路径 |
| `resolution` | `1280x720` | 引擎窗口分辨率；降低可提升抓帧速度 |
| `width` | `960` | 推流宽度（保持纵横比），0 = 原分辨率 |
| `fps` | `20` | 推流帧率 |
| `quality` | `0.7` | JPEG 质量 |
| `streamPort` | `8711` | 内部串流端口（仅 127.0.0.1） |
| `hideWindow` | `true` | 启动后把窗口移出屏幕 + 无边框 |
| `scene` | 空 | 主场景覆盖，空 = 读 project.godot |

## 工具

`godot_live_start({ projectRoot?, scene?, width?, fps?, resolution? })`
—— 不传 `projectRoot` 时从 DSH 当前工作目录向上找 `project.godot`。

`godot_live_input({ action, name?, x?, y?, keycode?, down?, duration_ms? })`
- `press` / `release` / `tap`：用 InputMap 动作名（`action: "actions"` 可列出可用动作）
- `click` / `move`：视口逻辑坐标
- `key`：Godot keycode

`godot_live_screenshot()` —— 返回 JPEG 图片附件，agent 可直接看。

## 已知限制

1. **需要真实渲染窗口**。Godot 没有"无窗口渲染"，所以进程会短暂闪一下窗口
   （`hideWindow: true` 时会立刻移出屏幕 + 去边框，尽量小）。
2. **MJPEG 是有损 + 有延迟**。适合调试和肉眼验证，不适合逐像素比对。
   要逐像素验证仍请用「固定种子 + 帧计数状态机 + save_png」那条路。
3. **输入注入走 InputMap**，不走操作系统级事件。好处是不需要辅助功能权限；
   坏处是对自己读原始 `InputEvent` 而不走 InputMap 的游戏可能不生效。
4. 面板画面是 `<img>` 流，浏览器对 MJPEG 的支持是历史遗留特性（Chrome / Safari / Firefox 都支持）。

## 许可

MIT
