# dsh-godot-live —— Godot 端实时画面串流运行时（零侵入）
#
# 用 `godot --path <项目> --script <本文件>` 启动。
# 不往用户项目里加任何文件、不改 project.godot、不装 autoload。
#
# 职责：
#   1. 载入项目主场景（读 project.godot 的 application/run/main_scene）
#   2. 在 127.0.0.1 上起一个极简 HTTP 服务
#   3. GET /         → multipart/x-mixed-replace 的 MJPEG 帧流（浏览器 <img> 直接显示）
#   4. GET /frame.jpg → 单帧 JPEG（面板缩略图 / 调试用）
#   5. GET /status    → JSON 运行状态
#   6. POST /input    → 注入输入事件（键鼠），让 agent 能"玩"这个游戏
#
# 为什么不用 Web 导出：
#   Web 导出只支持 Compatibility 渲染器，且需要安装 export templates。
#   本项目是 Forward+ 且未装模板。而本方案走**原生进程渲染**，
#   渲染器、GDExtension、autoload 全部保持原样，浏览器只收 JPEG 帧。
#
# 踩坑（本项目 docs/development/godot-pitfalls.md）：
#   - headless 下 get_texture().get_image() 返回 null → 必须开真实窗口
#   - 不开 --headless 即可；窗口可用 --position 移出屏幕 + 加 --borderless 隐藏
#   - 所有 headless 调用都要 --log-file（这里不开 headless，但仍建议带）

extends SceneTree

# ── 配置（可由命令行 `--` 之后的自定义参数覆盖）────────────────────────────
## 监听端口。插件侧通过环境变量 DSH_GODOT_LIVE_PORT 探测同一份配置。
var port: int = 8711
## 目标推流帧率。渲染帧率不受影响。
var target_fps: int = 20
## 推流缩放后的宽度；高度按主场景纵横比自动算。0 = 不缩放（原分辨率）。
var stream_width: int = 960
## JPEG 质量 0.1 ~ 1.0。0.7 在 960x540 下约 40KB/帧。
var jpeg_quality: float = 0.7
## 主场景路径覆盖。空 = 读 project.godot。
var scene_path: String = ""

# ── 状态 ───────────────────────────────────────────────────────────────────
var _server: TCPServer = null
var _clients: Array = []          # [{peer, type, buf, seq}]
var _frame: int = 0
var _last_jpg: PackedByteArray = PackedByteArray()
## 每产生一帧自增；推流端据此判断"有没有新帧"，避免把同一帧重复刷给客户端。
var _jpg_seq: int = 0
var _last_capture_ms: float = 0.0
var _frames_served: int = 0
var _started_at: int = 0
var _scene_root: Node = null
var _stream_size: Vector2i = Vector2i.ZERO
var _diag_count: int = 0

func _initialize() -> void:
	_started_at = Time.get_ticks_msec()
	_parse_cmdline()
	_load_scene()
	var err := _start_server()
	print("[dsh-godot-live] port=", port, " listen=", error_string(err),
		" fps=", target_fps, " width=", stream_width, " quality=", jpeg_quality)
	print("[dsh-godot-live] scene=", scene_path)

func _parse_cmdline() -> void:
	# Godot 把 `--` 之后的参数留给用户脚本；用 --dsh-xxx 键值对传参。
	for arg in OS.get_cmdline_user_args():
		var a: String = String(arg)
		if not a.begins_with("--"):
			continue
		var body: String = a.substr(2)
		var eq: int = body.find("=")
		var key: String = body if eq < 0 else body.substr(0, eq)
		var val: String = "" if eq < 0 else body.substr(eq + 1)
		match key:
			"port":
				port = int(val)
			"fps":
				target_fps = maxi(1, int(val))
			"width":
				stream_width = maxi(0, int(val))
			"quality":
				jpeg_quality = clampf(float(val), 0.1, 1.0)
			"scene":
				scene_path = val

	# 环境变量兜底（插件同时设 env 更可靠）
	if OS.has_environment("DSH_GODOT_LIVE_PORT"):
		var ep := OS.get_environment("DSH_GODOT_LIVE_PORT")
		if ep.is_valid_int():
			port = int(ep)
	if OS.has_environment("DSH_GODOT_LIVE_SCENE"):
		var es := OS.get_environment("DSH_GODOT_LIVE_SCENE")
		if not es.is_empty():
			scene_path = es

func _load_scene() -> void:
	if scene_path.is_empty():
		scene_path = String(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene_path.is_empty():
		print("[dsh-godot-live] ERROR: no main scene (project.godot 缺 application/run/main_scene)")
		return
	var packed: PackedScene = load(scene_path)
	if packed == null:
		print("[dsh-godot-live] ERROR: cannot load scene ", scene_path)
		return
	_scene_root = packed.instantiate()
	if _scene_root == null:
		print("[dsh-godot-live] ERROR: instantiate failed ", scene_path)
		return
	root.add_child(_scene_root)
	print("[dsh-godot-live] instantiated ", _scene_root.name)

func _start_server() -> int:
	_server = TCPServer.new()
	var err := _server.listen(port, "127.0.0.1")
	return err

# ── 主循环 ─────────────────────────────────────────────────────────────────
func _process(_delta: float) -> bool:
	_frame += 1
	_accept_clients()
	_poll_clients()
	# 按目标帧率节流抓帧：19.2 渲染帧/秒 ≈ 每 3 帧抓 1 次（假设 60fps 渲染）
	# 用时间戳更稳，避免不同刷新率下帧率失控
	if _should_capture():
		_capture_frame()
	if _frame % 300 == 0:
		_diag_count += 1
		print("[dsh-godot-live] alive frame=", _frame, " clients=", _clients.size(),
			" served=", _frames_served, " capture_ms=", "%.2f" % _last_capture_ms,
			" bytes=", _last_jpg.size())
	return false

var _last_capture_at: int = 0

func _should_capture() -> bool:
	var now := Time.get_ticks_msec()
	var interval := int(1000.0 / float(maxi(1, target_fps)))
	if now - _last_capture_at < interval:
		return false
	_last_capture_at = now
	return true

func _capture_frame() -> void:
	var tex := root.get_texture()
	if tex == null:
		return
	var t0 := Time.get_ticks_usec()
	var img: Image = tex.get_image()
	if img == null:
		return
	# 首次抓帧时确定推流尺寸（保持纵横比）
	if _stream_size == Vector2i.ZERO:
		if stream_width > 0 and img.get_width() > stream_width:
			var h: int = int(round(float(img.get_height()) * float(stream_width) / float(img.get_width())))
			_stream_size = Vector2i(stream_width, maxi(2, h))
		else:
			_stream_size = img.get_size()
		# JPEG 要求宽高为偶数更友好
		_stream_size = Vector2i(_stream_size.x & ~1, _stream_size.y & ~1)
		print("[dsh-godot-live] stream_size=", _stream_size)
	if img.get_size() != _stream_size:
		img.resize(_stream_size.x, _stream_size.y, Image.INTERPOLATE_BILINEAR)
	_last_jpg = img.save_jpg_to_buffer(jpeg_quality)
	_jpg_seq += 1
	_last_capture_ms = float(Time.get_ticks_usec() - t0) / 1000.0

# ── HTTP 服务 ──────────────────────────────────────────────────────────────
func _accept_clients() -> void:
	if _server == null:
		return
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer == null:
			continue
		peer.set_no_delay(true)
		_clients.append({
			"peer": peer, "type": "", "buf": PackedByteArray(),
			"seq": -1, "content_length": 0,
		})

func _poll_clients() -> void:
	var keep: Array = []
	for c in _clients:
		var peer: StreamPeerTCP = c["peer"]
		peer.poll()
		var status := peer.get_status()
		if status != StreamPeerTCP.STATUS_CONNECTED:
			continue
		var n := peer.get_available_bytes()
		if n > 0:
			var chunk: PackedByteArray = peer.get_data(n)[1]
			c["buf"].append_array(chunk)
			# 请求头以 \r\n\r\n 结束
			if c["type"] == "":
				var raw: PackedByteArray = c["buf"]
				var text: String = raw.get_string_from_utf8()
				var end := text.find("\r\n\r\n")
				if end >= 0:
					_handle_request(c, text.substr(0, end), text.substr(end + 4))
		# POST /input 的请求体可能晚于头部到达：头部解析完但 body 还不够长时继续等
		if c["type"] == "pending-body":
			var body: String = c["buf"].get_string_from_utf8()
			if body.length() >= int(c["content_length"]):
				_apply_input_body(c, body.substr(0, int(c["content_length"])))
		# 推流客户端：只在有新帧时发送，避免把同一帧重复推成高帧率
		if c["type"] == "stream" and _jpg_seq != int(c["seq"]) and _last_jpg.size() > 0:
			_write_stream_frame(peer)
			c["seq"] = _jpg_seq
			_frames_served += 1
		keep.append(c)
	_clients = keep

func _handle_request(c: Dictionary, head: String, rest: String) -> void:
	var peer: StreamPeerTCP = c["peer"]
	var first_line: String = head.split("\r\n", false)[0] if head.find("\r\n") >= 0 else head
	var parts := first_line.split(" ", false)
	var method: String = parts[0] if parts.size() > 0 else "GET"
	var target: String = parts[1] if parts.size() > 1 else "/"
	var path: String = target.split("?", false)[0]

	# CORS 预检
	if method == "OPTIONS":
		c["type"] = "done"
		var h := "HTTP/1.1 204 No Content\r\n"
		h += "Access-Control-Allow-Origin: *\r\n"
		h += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
		h += "Access-Control-Allow-Headers: content-type\r\n"
		h += "Content-Length: 0\r\nConnection: close\r\n\r\n"
		peer.put_data(h.to_utf8_buffer())
		return

	if method == "POST" and path == "/input":
		# 从头部里取 Content-Length，body 若已到齐就直接处理，否则进入 pending-body 等下一轮
		var clen := 0
		for line in head.split("\r\n", false):
			var lower := String(line).to_lower()
			if lower.begins_with("content-length:"):
				clen = int(String(line).substr(15).strip_edges())
				break
		if rest.length() >= clen and clen >= 0:
			_apply_input_body(c, rest.substr(0, clen))
		else:
			c["type"] = "pending-body"
			c["content_length"] = clen
			c["buf"] = rest.to_utf8_buffer()
		return

	match path:
		"/", "/stream", "/index.html":
			var hdr := "HTTP/1.1 200 OK\r\n"
			hdr += "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
			hdr += "Cache-Control: no-store, no-cache, must-revalidate\r\n"
			hdr += "Pragma: no-cache\r\n"
			hdr += "Connection: close\r\n"
			hdr += "Access-Control-Allow-Origin: *\r\n"
			hdr += "\r\n"
			peer.put_data(hdr.to_utf8_buffer())
			c["type"] = "stream"
			# 立刻推第一帧，避免 <img> 空等
			if _last_jpg.size() > 0:
				_write_stream_frame(peer)
				c["seq"] = _jpg_seq
				_frames_served += 1
		"/frame.jpg":
			c["type"] = "done"
			if _last_jpg.size() == 0:
				_send_simple(peer, 503, "text/plain", "no frame yet")
			else:
				var h := "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n"
				h += "Cache-Control: no-store\r\nConnection: close\r\n"
				h += "Content-Length: " + str(_last_jpg.size()) + "\r\n"
				h += "Access-Control-Allow-Origin: *\r\n\r\n"
				peer.put_data(h.to_utf8_buffer())
				peer.put_data(_last_jpg)
		"/status":
			c["type"] = "done"
			_send_simple(peer, 200, "application/json", _status_json())
		_:
			c["type"] = "done"
			_send_simple(peer, 404, "text/plain", "not found")

func _status_json() -> String:
	var d := {
		"ok": true,
		"engine": Engine.get_version_info().get("string", "?"),
		"display": DisplayServer.get_name(),
		"scene": scene_path,
		"scene_loaded": _scene_root != null,
		"stream_size": [_stream_size.x, _stream_size.y],
		"target_fps": target_fps,
		"frames": _frame,
		"frames_served": _frames_served,
		"capture_ms": _last_capture_ms,
		"jpeg_bytes": _last_jpg.size(),
		"uptime_ms": Time.get_ticks_msec() - _started_at,
		"clients": _clients.size(),
		"viewport": [root.get_visible_rect().size.x, root.get_visible_rect().size.y],
	}
	return JSON.stringify(d)

func _write_stream_frame(peer: StreamPeerTCP) -> void:
	var head := "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " \
		+ str(_last_jpg.size()) + "\r\n\r\n"
	peer.put_data(head.to_utf8_buffer())
	peer.put_data(_last_jpg)
	peer.put_data("\r\n".to_utf8_buffer())

func _send_simple(peer: StreamPeerTCP, code: int, ctype: String, body: String) -> void:
	var payload := body.to_utf8_buffer()
	var h := "HTTP/1.1 " + str(code) + " OK\r\n"
	h += "Content-Type: " + ctype + "\r\n"
	h += "Content-Length: " + str(payload.size()) + "\r\n"
	h += "Cache-Control: no-store\r\n"
	h += "Connection: close\r\n"
	h += "Access-Control-Allow-Origin: *\r\n\r\n"
	peer.put_data(h.to_utf8_buffer())
	peer.put_data(payload)

# ── 输入注入 ────────────────────────────────────────────────────────────────
# 让 agent 能"玩"这个游戏：把动作翻译成 InputEvent 喂给根窗口。
# 只支持 InputMap 动作 + 原始键鼠，够覆盖绝大多数游戏调试场景。
#
# 用 Input.action_press / action_release 而不是 Input.parse_input_event，
# 因为前者对 Godot 4 的 Input.is_action_pressed() 语义最稳（游戏几乎都这么读输入）。

func _apply_input_body(c: Dictionary, body: String) -> void:
	c["type"] = "done"
	var peer: StreamPeerTCP = c["peer"]
	var data = JSON.parse_string(body)
	if typeof(data) != TYPE_DICTIONARY:
		_send_simple(peer, 400, "application/json", '{"ok":false,"error":"body must be JSON object"}')
		return
	var result := _inject_input(data)
	_send_simple(peer, 200, "application/json", JSON.stringify(result))

func _inject_input(d: Dictionary) -> Dictionary:
	var action := String(d.get("action", ""))
	var release := bool(d.get("release", false))
	var duration_ms := int(d.get("duration_ms", 0))

	match action:
		"press", "tap":
			var name := String(d.get("name", ""))
			if name.is_empty():
				return {"ok": false, "error": "name required"}
			if not InputMap.has_action(name):
				return {"ok": false, "error": "unknown input action: " + name,
					"available": _available_actions()}
			if release or action == "tap":
				Input.action_press(name)
				if duration_ms > 0:
					# 不能阻塞主循环，用 Timer 在 duration 后释放
					_release_after(name, duration_ms)
				else:
					Input.action_release(name)
					return {"ok": true, "action": name, "tapped": true}
				return {"ok": true, "action": name, "will_release_ms": duration_ms}
			Input.action_press(name)
			return {"ok": true, "action": name, "pressed": true}
		"release":
			var name2 := String(d.get("name", ""))
			if name2.is_empty():
				return {"ok": false, "error": "name required"}
			Input.action_release(name2)
			return {"ok": true, "action": name2, "released": true}
		"actions":
			return {"ok": true, "available": _available_actions()}
		"click":
			# 坐标口径：调用方给的是**视口逻辑坐标**（1920x1080），
			# 但 InputEvent 的 position 走的是**窗口像素**（1280x720）。
			# 本项目 stretch=canvas_items/expand，两者差一个缩放比 —— 
			# 不做转换的话，GUI 按钮永远点不到（踩过：点「重新开始」毫无反应）。
			var pos := _viewport_to_window(Vector2(float(d.get("x", 0)), float(d.get("y", 0))))
			var button := int(d.get("button", MOUSE_BUTTON_LEFT))
			# GUI 需要成对事件：先在目标上移动（Button 的高亮/pressed 依赖 hover 状态），
			# 再按下、再抬起。少了 move，部分控件的 hover 判定不会更新。
			var mv := InputEventMouseMotion.new()
			mv.position = pos
			mv.global_position = pos
			mv.button_mask = MOUSE_BUTTON_MASK_LEFT
			Input.parse_input_event(mv)
			for pressed in [true, false]:
				var ev := InputEventMouseButton.new()
				ev.button_index = button
				ev.pressed = pressed
				ev.position = pos
				ev.global_position = pos
				ev.button_mask = MOUSE_BUTTON_MASK_LEFT if pressed else 0
				Input.parse_input_event(ev)
			return {"ok": true, "clicked": [pos.x, pos.y], "button": button,
				"space": "window"}
		"move":
			var pos2 := _viewport_to_window(Vector2(float(d.get("x", 0)), float(d.get("y", 0))))
			var mv := InputEventMouseMotion.new()
			mv.position = pos2
			mv.global_position = pos2
			Input.parse_input_event(mv)
			return {"ok": true, "moved": [pos2.x, pos2.y]}
		"key":
			var keycode := int(d.get("keycode", 0))
			var physical := int(d.get("physical_keycode", 0))
			if keycode == 0 and physical == 0:
				return {"ok": false, "error": "keycode or physical_keycode required"}
			var down := bool(d.get("down", true))
			var kev := InputEventKey.new()
			kev.keycode = keycode
			kev.physical_keycode = physical
			kev.pressed = down
			Input.parse_input_event(kev)
			return {"ok": true, "keycode": keycode, "physical": physical, "down": down}
		_:
			return {"ok": false, "error": "unknown action: " + action,
				"supported": ["press", "release", "tap", "click", "move", "key", "actions"]}

func _available_actions() -> Array:
	var out: Array = []
	for a in InputMap.get_actions():
		var s := String(a)
		if s.begins_with("ui_"):
			continue
		out.append(s)
	out.sort()
	return out

func _release_after(action_name: String, ms: int) -> void:
	var timer := Timer.new()
	timer.one_shot = true
	timer.wait_time = maxf(0.01, float(ms) / 1000.0)
	timer.timeout.connect(func() -> void:
		Input.action_release(action_name)
		timer.queue_free()
	)
	# Timer 需要进场景树才会走；挂到 root 上，不污染游戏场景
	root.add_child(timer)
	timer.start()

## 视口逻辑坐标 → 窗口像素坐标。
##
## 本项目 `display/window/stretch/mode="canvas_items"` + aspect="expand"，
## 视口逻辑尺寸固定 1920x1080，而实际窗口可能是 1280x720 等。
## `InputEventMouse*` 的 position 用窗口像素，GUI 命中测试也按窗口算，
## 所以注入前必须换算；否则点击会落在错误位置（症状：按钮点了没反应）。
func _viewport_to_window(pos: Vector2) -> Vector2:
	var win_size := Vector2(DisplayServer.window_get_size())
	var vp_size := root.get_visible_rect().size
	if vp_size.x <= 0.0 or vp_size.y <= 0.0:
		return pos
	# expand 模式下宽高各自独立缩放
	var scale := Vector2(win_size.x / vp_size.x, win_size.y / vp_size.y)
	return (pos * scale).round()
