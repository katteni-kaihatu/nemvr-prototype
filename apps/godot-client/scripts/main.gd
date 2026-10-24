extends Node

const WorldProjection = preload("res://scripts/world_projection.gd")
const Mirror = preload("res://scripts/mirror.gd")
const FloorReflection = preload("res://scripts/floor_reflection.gd")
const VoiceChat = preload("res://scripts/voice_chat.gd")

@onready var projection: WorldProjection = $World/Entities
@onready var player: Node3D = $World/Player
@onready var camera: Camera3D = $World/Player/Camera
@onready var xr_rig: Node3D = $World/Player/XRRig
@onready var xr_status: Label3D = $World/Player/XRRig/XRCamera/XRStatus
@onready var teleport_marker: MeshInstance3D = $World/TeleportMarker
@onready var laser: MeshInstance3D = $World/Laser
@onready var laser_dot: MeshInstance3D = $World/LaserDot
@onready var mic_label: Label = $Interface/HUD/MicLabel
@onready var mic_level: ProgressBar = $Interface/HUD/MicLevel
@onready var out_label: Label = $Interface/HUD/OutLabel
@onready var out_level: ProgressBar = $Interface/HUD/OutLevel
@onready var xr_menu: Node3D = $World/Player/XRRig/XRCamera/XRMenu
@onready var mirror: Mirror = $World/Mirror
@onready var floor_reflection: FloorReflection = $World/FloorReflection
@onready var world_environment: WorldEnvironment = $World/Environment
@onready var sun: DirectionalLight3D = $World/Sun
@onready var lobby: PanelContainer = $Interface/Lobby
@onready var fields: VBoxContainer = $Interface/Lobby/Margin/Fields
@onready var server_edit: LineEdit = $Interface/Lobby/Margin/Fields/Server
@onready var name_edit: LineEdit = $Interface/Lobby/Margin/Fields/Name
@onready var quality_option: OptionButton = $Interface/Lobby/Margin/Fields/Quality
@onready var mic_option: OptionButton = $Interface/Lobby/Margin/Fields/MicDevice
@onready var status_label: Label = $Interface/Lobby/Margin/Fields/Status
@onready var hud: Control = $Interface/HUD
@onready var hud_status: Label = $Interface/HUD/Status
@onready var log_label: Label = $Interface/HUD/Log
@onready var fps_label: Label = $Interface/HUD/FPS
@onready var debug_label: Label = $Interface/HUD/Debug
@onready var menu: PopupPanel = $Interface/Menu

var bridge: Object
var options: Dictionary = {}
var self_id: String = ""
var in_world: bool = false
var status: String = "lobby"
var movement: Dictionary = {"position": [0.0, 0.0, 0.0], "vy": 0.0, "crouch": 0.0, "grounded": true, "airJumps": 1, "lean": 0.0, "yaw": 0.0}
var yaw: float = 0.0
var pitch: float = 0.0
var carry_id: String = ""
var carry_distance: float = 2.0
var carry_yaw: float = 0.0
var carry_pitch: float = 0.0
var carry_scale: float = 1.0
var rotate_mode: bool = false
var menu_id: String = ""
var pending: Dictionary = {}
var _events: Array = []
var _logs: Array[String] = []
var _transfer: String = ""
var _pose_clock: float = 0.0
var _fps_clock: float = 0.0
var _jump_pressed: bool = false
var _started: float = 0.0
var _entered: float = -1.0
var _scenario_id: String = ""
var _scenario_stage: int = 0
var _scenario_observed: Dictionary = {}
var _screenshot_started: bool = false
var _quitting: bool = false
var _avatar_path: String = ""
var _avatar_reset_pending: bool = false
var _ipfs_ready: bool = false
var xr_active: bool = false
var version: String = str(ProjectSettings.get_setting("application/config/version", "dev"))
var voice: Node
var _teleport_marker_until: float = 0.0
var quality: String = "high"
var _benchmark_samples: Array[float] = []
var _benchmark_started_at: float = 0.0
var _benchmark_seconds: float = 10.0
var _benchmark_done: bool = false

func _ready() -> void:
	_started = Time.get_ticks_msec() * 0.001
	options = _parse_options(OS.get_cmdline_user_args())
	_setup_theme()
	projection.asset_requested.connect(_fetch)
	projection.observed.connect(_observe)
	projection.notice.connect(_log)
	voice = VoiceChat.new()
	add_child(voice)
	voice.state_changed.connect(func(value: String) -> void: _log("Voice: " + value))
	if options.has("xr") or options.has("xr-mock"):
		xr_active = xr_rig.call("activate", camera, options.has("xr-mock"))
		if xr_active:
			camera = xr_rig.get_node("XRCamera")
			xr_status.visible = true
			laser.visible = true
			laser_dot.visible = true
			xr_menu.action.connect(_on_xr_menu_action)
			if options.has("xr-menu"):
				xr_menu.visible = true
			_log("OpenXR active" if not options.has("xr-mock") else "XR mock active")
		else:
			_log("OpenXR runtime unavailable; desktop mode")
	mirror.source = camera
	floor_reflection.source = camera
	projection.hand_ik_enabled = options.has("hand-ik")
	if options.has("benchmark"):
		_benchmark_seconds = 10.0 if options["benchmark"] is bool else float(options["benchmark"])
	_setup_quality()
	_setup_microphone()
	fields.get_node("Connect").pressed.connect(_connect)
	fields.get_node("ResetAvatar").pressed.connect(_reset_avatar)
	name_edit.text_submitted.connect(func(_text: String) -> void: _connect())
	server_edit.text_submitted.connect(func(_text: String) -> void: name_edit.grab_focus())
	$Interface/HUD/Disconnect.pressed.connect(_disconnect)
	$Interface/Menu/Actions/Delete.pressed.connect(func() -> void: _menu_action("delete"))
	$Interface/Menu/Actions/Duplicate.pressed.connect(func() -> void: _menu_action("duplicate"))
	$Interface/Menu/Actions/Download.pressed.connect(func() -> void: _menu_action("download"))
	$Interface/Menu/Actions/Close.pressed.connect(func() -> void: menu.hide())
	get_window().files_dropped.connect(_files_dropped)
	get_tree().auto_accept_quit = false
	if not ClassDB.class_exists("ProtoClient"):
		_log("Native ProtoClient extension is unavailable. Build/stage the GDExtension first.")
		fields.get_node("Connect").disabled = true
	else:
		bridge = ClassDB.instantiate("ProtoClient")
		projection.image_decoder = bridge
		if options.has("data-dir") and bridge.has_method("configure"):
			bridge.call("configure", str(options["data-dir"]))
		var result: Dictionary = _command({"op": "config"})
		var config: Dictionary = result.get("value", {}) if result.get("value") is Dictionary else {}
		server_edit.text = str(config.get("server", server_edit.text))
		name_edit.text = str(config.get("name", ""))
	if options.has("server"):
		server_edit.text = str(options["server"])
	if options.has("name"):
		name_edit.text = str(options["name"])
	if options.has("avatar"):
		_avatar_path = str(options["avatar"])
	if options.has("name") and bridge != null:
		_connect()

func _setup_microphone() -> void:
	mic_option.clear()
	var devices: PackedStringArray = AudioServer.get_input_device_list()
	mic_option.add_item("Default", 0)
	var index: int = 1
	for device: String in devices:
		mic_option.add_item(device, index)
		index += 1
	var saved: String = _load_mic()
	if options.has("mic"):
		saved = str(options["mic"])
	var selected: int = 0
	for i in mic_option.item_count:
		if mic_option.get_item_text(i) == saved:
			selected = i
			break
	mic_option.selected = selected
	mic_option.item_selected.connect(_mic_selected)

func _mic_selected(index: int) -> void:
	var device: String = mic_option.get_item_text(index)
	if device == "Default":
		device = ""
	_save_mic(device)

func _load_mic() -> String:
	var config: ConfigFile = ConfigFile.new()
	if config.load("user://settings.cfg") != OK:
		return ""
	return str(config.get_value("audio", "microphone", ""))

func _save_mic(device: String) -> void:
	var config: ConfigFile = ConfigFile.new()
	config.load("user://settings.cfg")
	config.set_value("audio", "microphone", device)
	config.save("user://settings.cfg")

func _selected_mic() -> String:
	var text: String = mic_option.get_item_text(mic_option.selected)
	return "" if text == "Default" else text

func _setup_quality() -> void:
	quality_option.add_item("High", 0)
	quality_option.add_item("Medium", 1)
	quality_option.add_item("Low", 2)
	var saved: String = _load_quality()
	if options.has("quality"):
		saved = str(options["quality"]).to_lower()
	if not ["high", "medium", "low"].has(saved):
		saved = "high"
	quality_option.selected = ["high", "medium", "low"].find(saved)
	quality_option.item_selected.connect(_quality_selected)
	_apply_quality(saved)

func _quality_selected(index: int) -> void:
	var level: String = ["high", "medium", "low"][clampi(index, 0, 2)]
	_apply_quality(level)
	_save_quality(level)

func _apply_quality(level: String) -> void:
	quality = level
	floor_reflection.set_quality(level)
	if options.has("no-floor-reflection"):
		floor_reflection.set_enabled(false)
	var environment: Environment = world_environment.environment
	var low: bool = level == "low"
	environment.ssao_enabled = not low
	environment.glow_enabled = not low
	environment.fog_enabled = not low
	sun.directional_shadow_max_distance = 72.0 if level == "high" else (48.0 if level == "medium" else 28.0)
	get_viewport().scaling_3d_scale = 1.0 if level == "high" else (0.85 if level == "medium" else 0.7)

func _load_quality() -> String:
	var config: ConfigFile = ConfigFile.new()
	if config.load("user://settings.cfg") != OK:
		return "high"
	return str(config.get_value("graphics", "quality", "high"))

func _save_quality(level: String) -> void:
	var config: ConfigFile = ConfigFile.new()
	config.load("user://settings.cfg")
	config.set_value("graphics", "quality", level)
	config.save("user://settings.cfg")

func _setup_theme() -> void:
	$Interface/Lobby/Margin/Fields/Title.text = "PROTO / SNS  v" + version
	$Interface/Lobby/Margin/Fields/Subtitle.text = "Shared space · Desktop client · v" + version
	var theme: Theme = Theme.new()
	theme.default_font_size = 18
	var font_path: String = "res://assets/fonts/Migu-1M-regular.ttf"
	if ResourceLoader.exists(font_path):
		var font: Font = load(font_path) as Font
		theme.default_font = font
		projection.font = font
	var panel: StyleBoxFlat = StyleBoxFlat.new()
	panel.bg_color = Color(0.055, 0.085, 0.11, 0.97)
	panel.border_color = Color(0.25, 0.58, 0.55)
	panel.set_border_width_all(1)
	panel.set_corner_radius_all(6)
	theme.set_stylebox("panel", "PanelContainer", panel)
	theme.set_stylebox("panel", "PopupPanel", panel)
	var button: StyleBoxFlat = StyleBoxFlat.new()
	button.bg_color = Color(0.12, 0.34, 0.33)
	button.content_margin_top = 8
	button.content_margin_bottom = 8
	button.content_margin_left = 14
	button.content_margin_right = 14
	theme.set_stylebox("normal", "Button", button)
	var hover: StyleBoxFlat = button.duplicate() as StyleBoxFlat
	hover.bg_color = Color(0.18, 0.46, 0.43)
	theme.set_stylebox("hover", "Button", hover)
	lobby.theme = theme
	hud.theme = theme
	menu.theme = theme
	# The same bundled font covers native text input and Japanese 3D labels.
	fields.get_node("ServerLabel").text = "サーバー / Server"
	fields.get_node("NameLabel").text = "表示名 / Name"
	fields.get_node("QualityLabel").text = "画質 / Quality"
	fields.get_node("MicLabel").text = "マイク / Microphone"
	fields.get_node("Connect").text = "接続 / Connect"

func _parse_options(arguments: PackedStringArray) -> Dictionary:
	var parsed: Dictionary = {}
	var index: int = 0
	while index < arguments.size():
		var argument: String = arguments[index]
		if argument.begins_with("--"):
			var pair: PackedStringArray = argument.substr(2).split("=", true, 1)
			var key: String = pair[0]
			if pair.size() == 2:
				parsed[key] = pair[1]
			elif index + 1 < arguments.size() and not arguments[index + 1].begins_with("--"):
				index += 1
				parsed[key] = arguments[index]
			else:
				parsed[key] = true
		index += 1
	return parsed

func _connect() -> void:
	if bridge == null:
		return
	_disconnect()
	status = "connecting"
	status_label.text = "接続中 / Connecting…"
	fields.get_node("Connect").disabled = true
	var result: Dictionary = _command({"op": "connect", "server": server_edit.text.strip_edges(), "name": name_edit.text.strip_edges()})
	if not result.get("ok", false):
		status = "lobby"
		fields.get_node("Connect").disabled = false

func _disconnect(send_command: bool = true) -> void:
	if bridge != null and send_command:
		_command({"op": "disconnect"})
	in_world = false
	status = "lobby"
	self_id = ""
	carry_id = ""
	_ipfs_ready = false
	pending.clear()
	projection.clear()
	menu.hide()
	mirror.set_enabled(false)
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	lobby.show()
	hud.hide()
	fields.get_node("Connect").disabled = bridge == null
	_entered = -1
	_scenario_stage = 0
	_scenario_id = ""
	_scenario_observed.clear()
	movement = {"position": [0.0, 0.0, 0.0], "vy": 0.0, "crouch": 0.0, "grounded": true, "airJumps": 1, "lean": 0.0, "yaw": 0.0}
	yaw = 0
	pitch = 0

func _command(payload: Dictionary) -> Dictionary:
	if bridge == null:
		return {"ok": false, "error": "Native extension unavailable"}
	var result: Dictionary = bridge.call("command", payload)
	if not result.get("ok", false):
		_log(str(result.get("error", "Command rejected")))
	return result

func _fetch(cid: String) -> void:
	_command({"op": "fetch", "cid": cid})

func _process(delta: float) -> void:
	if bridge != null:
		_events.append_array(bridge.call("poll_events"))
	for _index: int in range(mini(_events.size(), 256)):
		var event: Dictionary = _events.pop_front()
		_handle_event(event)
	var now: float = Time.get_ticks_msec() * 0.001
	for id: String in pending.keys():
		if now - float(pending[id]["time"]) > 8.0:
			var operation: String = str(pending[id]["op"])
			if operation == "claim" and carry_id == pending[id]["entityId"]:
				_rollback(carry_id)
			pending.erase(id)
	if in_world:
		_update_carry()
		_update_target()
		_pose_clock += delta
		if _pose_clock >= 0.05:
			_pose_clock = fmod(_pose_clock, 0.05)
			_send_pose()
			_send_carry()
		_automation(now)
	if xr_active:
		if options.has("xr-snap-turn"):
			var turn: float = float(xr_rig.call("consume_snap_turn"))
			if turn != 0.0:
				yaw += turn
		else:
			yaw -= float(xr_rig.call("get_turn")) * deg_to_rad(90.0) * delta
		if bool(xr_rig.call("consume_menu")):
			xr_menu.visible = not xr_menu.visible
		_update_laser()
		if bool(xr_rig.call("consume_grab")):
			var ray: Array = xr_rig.call("hand_ray", "right")
			if xr_menu.visible:
				var chosen: String = xr_menu.pick(ray[0], ray[1])
				if not chosen.is_empty():
					_on_xr_menu_action(chosen)
				else:
					_toggle_carry(ray[0], ray[1])
			else:
				_toggle_carry(ray[0], ray[1])
		if bool(xr_rig.call("consume_teleport")):
			var ray: Array = xr_rig.call("hand_ray", "right")
			var hit: Dictionary = projection.floor_hit(ray[0], ray[1])
			if hit.get("hit", false):
				movement["position"] = WorldProjection.array3(hit["position"])
				teleport_marker.global_position = Vector3(hit["position"].x, 0.02, hit["position"].z)
				teleport_marker.visible = true
				_teleport_marker_until = now + 0.4
	_fps_clock += delta
	if _fps_clock >= 0.25:
		_fps_clock = 0.0
		var fps: int = Engine.get_frames_per_second()
		fps_label.text = "%d FPS  /  %.1f ms" % [fps, 1000.0 / maxf(float(fps), 1.0)]
	if options.has("benchmark") and in_world and not _benchmark_done:
		var benchmark_elapsed: float = now - _entered
		if benchmark_elapsed >= 1.0:
			if _benchmark_started_at == 0.0:
				_benchmark_started_at = now
			_benchmark_samples.append(float(Engine.get_frames_per_second()))
			if now - _benchmark_started_at >= _benchmark_seconds:
				_finish_benchmark()
	if _teleport_marker_until > 0.0 and now > _teleport_marker_until:
		_teleport_marker_until = 0.0
		teleport_marker.visible = false
	if voice != null:
		var level: float = float(voice.call("get_input_level"))
		mic_label.visible = true
		mic_level.visible = true
		mic_level.value = level
		out_label.visible = true
		out_level.visible = true
		out_level.value = float(voice.call("get_output_level"))
		if xr_active:
			var mic_name: String = _selected_mic()
			if mic_name.is_empty():
				mic_name = "Default"
			xr_status.text = "%d FPS  /  %s  /  MIC %d%%  /  %s" % [Engine.get_frames_per_second(), status, int(level * 100.0), mic_name]
	else:
		mic_label.visible = false
		mic_level.visible = false
		out_label.visible = false
		out_level.visible = false
	if xr_active:
		xr_status.visible = xr_menu.visible or debug_label.visible
	else:
		xr_status.visible = false
	if debug_label.visible:
		var position: Vector3 = player.position
		debug_label.text = "FPS %d  /  entities %d\npos %.2f, %.2f, %.2f  /  yaw %.1f°\ncarry %s" % [
			Engine.get_frames_per_second(), projection.views.size(), position.x, position.y, position.z,
			rad_to_deg(yaw), carry_id.left(12) if not carry_id.is_empty() else "-"]
	var duration: float = float(options.get("duration", 0))
	if duration > 0 and now - _started >= duration and not _quitting:
		var success: bool = in_world
		if str(options.get("scenario", "")).contains("place"):
			success = success and _scenario_observed.get("created", false) and _scenario_observed.get("moved", false) and _scenario_observed.get("removed", false)
		_shutdown(0 if success else 1)

func _handle_event(event: Dictionary) -> void:
	match str(event.get("type", "")):
		"state":
			_state(event)
		"asset":
			projection.asset_ready(str(event.get("cid", "")), str(event.get("path", "")))
			_emit({"event": "asset", "cid": event.get("cid", ""), "path": event.get("path", "")})
		"progress":
			var total: String = str(event["total"]) if event.get("total") != null else "?"
			_transfer = "%s: %s / %s bytes" % [str(event.get("cid", "")).left(12), str(event.get("loaded", 0)), total]
		"error":
			var command_id: String = str(event.get("commandId", ""))
			if pending.has(command_id):
				_rollback(str(pending[command_id]["entityId"]))
				pending.erase(command_id)
			var failed_cid: String = str(event.get("cid", ""))
			if not failed_cid.is_empty():
				projection.asset_failed(failed_cid)
			_log(str(event.get("message", "Error")))
			_emit({"event": "error", "message": event.get("message", ""), "commandId": event.get("commandId"), "code": event.get("code"), "cid": event.get("cid")})
		"log":
			_log(str(event.get("message", "")))

func _state(event: Dictionary) -> void:
	var next_status: String = str(event.get("status", "lobby"))
	var own_id: String = str(event.get("selfId", "") if event.get("selfId") != null else "")
	var active: bool = not own_id.is_empty() and next_status.to_lower() == "online"
	if not active:
		if in_world:
			_disconnect(false)
		status = next_status
		status_label.text = next_status
		fields.get_node("Connect").disabled = next_status.to_lower() == "connecting"
		return
	var entering: bool = not in_world or own_id != self_id
	if entering:
		projection.clear()
		pending.clear()
		carry_id = ""
	self_id = own_id
	in_world = true
	_ipfs_ready = bool(event.get("ipfsReady", false))
	status = next_status
	lobby.hide()
	if options.has("hide-hud") or xr_active:
		hud.hide()
	else:
		hud.show()
	projection.apply_snapshot(event.get("entities", []), self_id)
	if entering:
		_entered = Time.get_ticks_msec() * 0.001
		if projection.entities.has(self_id):
			var own_dims: Dictionary = projection.entities[self_id].get("dimensions", {})
			movement["position"] = own_dims.get("space.position", [0, 0, 0])
		if options.has("position"):
			var position: PackedStringArray = str(options["position"]).split(",")
			if position.size() >= 3:
				movement["position"] = [float(position[0]), float(position[1]), float(position[2])]
		if options.has("yaw"):
			yaw = deg_to_rad(float(options["yaw"]))
		if options.has("pitch"):
			pitch = deg_to_rad(float(options["pitch"]))
		if voice != null:
			if options.has("voice"):
				voice.call("start", server_edit.text, _selected_mic(), options.has("voice-test-tone"))
			elif DisplayServer.get_name() != "headless":
				voice.call("start_meter", _selected_mic())
		_emit({"event": "welcome", "selfId": self_id, "name": event.get("name", name_edit.text), "server": event.get("server", server_edit.text)})
		mirror.set_enabled(options.has("mirror"))
		if options.has("mirror"):
			_log("self-view mirror enabled")
		get_viewport().gui_release_focus()
	_submit_avatar()
	if not carry_id.is_empty():
		if not projection.entities.has(carry_id):
			carry_id = ""
		else:
			var dims: Dictionary = projection.entities[carry_id].get("dimensions", {})
			var holder: Variant = dims.get("interaction.heldBy")
			if holder == self_id:
				for id: String in pending.keys():
					if pending[id]["op"] == "claim" and pending[id]["entityId"] == carry_id:
						pending.erase(id)
			elif not _claim_pending(carry_id):
				_rollback(carry_id)
	hud_status.text = "%s  /  %s  /  RTT %s ms  /  IPFS %s  %s  /  v%s" % [str(event.get("name", name_edit.text)), next_status, str(event.get("rttMs", "?")), "ready" if event.get("ipfsReady", false) else "starting", _transfer, version]

func _physics_process(delta: float) -> void:
	if not in_world or bridge == null:
		return
	var enabled: bool = _controls_enabled()
	var input_value: Dictionary = {"moveX": 0.0, "moveZ": 0.0, "sprint": false, "jump": false, "jumpPressed": false, "crouch": false, "lean": 0.0}
	if enabled or xr_active:
		input_value["moveX"] = float(_key(KEY_D) or _key(KEY_RIGHT)) - float(_key(KEY_A) or _key(KEY_LEFT))
		input_value["moveZ"] = float(_key(KEY_S) or _key(KEY_DOWN)) - float(_key(KEY_W) or _key(KEY_UP))
		if xr_active:
			var stick: Vector2 = xr_rig.call("get_move")
			input_value["moveX"] = float(input_value["moveX"]) + stick.x
			input_value["moveZ"] = float(input_value["moveZ"]) - stick.y
		input_value["sprint"] = _key(KEY_SHIFT)
		input_value["jump"] = _key(KEY_SPACE)
		input_value["jumpPressed"] = _jump_pressed
		input_value["crouch"] = _key(KEY_C) or _key(KEY_CTRL)
		input_value["lean"] = float(_key(KEY_E) and carry_id.is_empty()) - float(_key(KEY_Q))
	_jump_pressed = false
	movement["yaw"] = yaw
	if bridge.has_method("step_movement"):
		movement = bridge.call("step_movement", movement, input_value, minf(delta, 0.05))
	var at: Vector3 = WorldProjection.vec3(movement.get("position", [0, 0, 0]))
	if bridge.has_method("resolve_collision"):
		var height: float = float(movement.get("eyeHeight", 1.6)) + 0.2
		var collision: Dictionary = bridge.call("resolve_collision", at, height, projection.obstacles(carry_id))
		at = collision.get("position", at)
		at = Vector3(clampf(at.x, -24, 24), maxf(at.y, 0), clampf(at.z, -24, 24))
		if collision.get("grounded", false):
			movement["grounded"] = true
			if float(movement.get("vy", 0)) < 0:
				movement["vy"] = 0.0
		if collision.get("hitCeiling", false):
			movement["vy"] = minf(float(movement.get("vy", 0)), 0)
		movement["position"] = WorldProjection.array3(at)
	player.position = at
	player.rotation.y = yaw
	camera.position = Vector3(float(movement.get("leanSide", 0)), float(movement.get("leanHeight", movement.get("eyeHeight", 1.6))), 0)
	camera.rotation = Vector3(pitch, 0, float(movement.get("leanRoll", 0)))
	projection.update_self(at, yaw, float(movement.get("crouch", 0)), float(movement.get("lean", 0)), pitch)

func _controls_enabled() -> bool:
	return in_world and not menu.visible and get_viewport().gui_get_focus_owner() == null and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED

func _key(code: Key) -> bool:
	return Input.is_physical_key_pressed(code)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.physical_keycode == KEY_ESCAPE:
		menu.hide()
		get_viewport().gui_release_focus()
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		get_viewport().set_input_as_handled()
		return
	if event is InputEventKey and event.pressed and not event.echo:
		if event.physical_keycode == KEY_F3:
			debug_label.visible = not debug_label.visible
			_log("Debug overlay %s" % ("on" if debug_label.visible else "off"))
			get_viewport().set_input_as_handled()
			return
		if event.physical_keycode == KEY_F12:
			_capture_screenshot()
			get_viewport().set_input_as_handled()
			return
	if not in_world or get_viewport().gui_get_focus_owner() != null or menu.visible:
		return
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_LEFT:
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		elif _controls_enabled():
			match event.button_index:
				MOUSE_BUTTON_RIGHT:
					_toggle_carry()
				MOUSE_BUTTON_MIDDLE:
					_open_menu()
				MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN:
					if not carry_id.is_empty():
						var direction: float = 1.0 if event.button_index == MOUSE_BUTTON_WHEEL_UP else -1.0
						if event.shift_pressed:
							carry_scale = clampf(carry_scale * pow(1.1, direction), 0.1, 10)
						else:
							carry_distance = clampf(carry_distance + direction * 0.25, 0.5, 8)
	elif event is InputEventMouseMotion and _controls_enabled():
		if rotate_mode and not carry_id.is_empty():
			carry_yaw -= event.relative.x * 0.005
			carry_pitch = clampf(carry_pitch - event.relative.y * 0.005, -PI * 0.49, PI * 0.49)
		else:
			yaw -= event.relative.x * 0.0025
			pitch = clampf(pitch - event.relative.y * 0.0025, -PI * 0.49, PI * 0.49)
	elif event is InputEventKey and event.pressed and not event.echo and _controls_enabled():
		match event.physical_keycode:
			KEY_SPACE:
				_jump_pressed = true
			KEY_B:
				_place_box(_floor_target())
			KEY_V:
				mirror.set_enabled(not mirror.visible)
			KEY_E:
				if not carry_id.is_empty():
					rotate_mode = not rotate_mode
			KEY_M:
				_open_menu()

func _send_pose() -> void:
	var head: Quaternion = camera.global_basis.get_rotation_quaternion()
	var pose: Dictionary = {"op": "pose", "position": movement["position"],
		"head": [head.x, head.y, head.z, head.w], "crouch": movement.get("crouch", 0),
		"lean": movement.get("lean", 0)}
	if xr_active:
		pose["leftHand"] = xr_rig.call("hand_pose", "left")
		pose["rightHand"] = xr_rig.call("hand_pose", "right")
	_command(pose)

func _update_laser() -> void:
	var ray: Array = xr_rig.call("hand_ray", "right")
	var origin: Vector3 = ray[0]
	var direction: Vector3 = ray[1]
	var distance: float = 4.0
	var point: Vector3 = origin + direction * distance
	var menu_target: String = xr_menu.pick(origin, direction) if xr_menu.visible else ""
	if not menu_target.is_empty():
		distance = 1.0
		point = origin + direction * distance
	else:
		var hit: Dictionary = projection.pick_hit(origin, direction, distance)
		if not str(hit["id"]).is_empty():
			distance = float(hit["distance"])
			point = hit["position"]
		else:
			var floor: Dictionary = projection.floor_hit(origin, direction, 12.0)
			if floor.get("hit", false):
				point = floor["position"]
				distance = origin.distance_to(point)
	laser.global_position = origin + direction * (distance * 0.5)
	laser.look_at(point, Vector3.UP)
	laser.scale = Vector3(1, 1, distance)
	laser_dot.global_position = point

func _on_xr_menu_action(name: String) -> void:
	match name:
		"box":
			_place_box(_floor_target())
		"mirror":
			mirror.set_enabled(not mirror.visible)
		"mic":
			if mic_option.item_count > 0:
				mic_option.selected = (mic_option.selected + 1) % mic_option.item_count
				_mic_selected(mic_option.selected)
				if voice != null:
					voice.call("stop")
					voice.call("start", server_edit.text, _selected_mic(), options.has("voice-test-tone"))
		"close":
			xr_menu.visible = false

func _toggle_carry(origin: Vector3 = Vector3.INF, direction: Vector3 = Vector3.ZERO) -> void:
	if not carry_id.is_empty():
		_send_carry()
		_mutate({"op": "release", "entityId": carry_id})
		carry_id = ""
		rotate_mode = false
		return
	var from: Vector3 = camera.global_position if origin == Vector3.INF else origin
	var dir: Vector3 = -camera.global_basis.z if direction == Vector3.ZERO else direction
	var id: String = projection.pick(from, dir)
	if id.is_empty():
		return
	var dims: Dictionary = projection.entities[id].get("dimensions", {})
	if dims.get("interaction.heldBy") != null and dims.get("interaction.heldBy") != self_id:
		_log("Object is held by another peer")
		return
	carry_id = id
	carry_distance = clampf(camera.global_position.distance_to(projection.views[id].global_position), 0.5, 8)
	carry_yaw = float(dims.get("space.yaw", 0))
	carry_pitch = float(dims.get("space.pitch", 0))
	carry_scale = float(dims.get("space.scale", 1))
	rotate_mode = false
	if not _mutate({"op": "claim", "entityId": id}):
		_rollback(id)

func _claim_pending(id: String) -> bool:
	for command_id: String in pending:
		if pending[command_id]["op"] == "claim" and pending[command_id]["entityId"] == id:
			return true
	return false

func _update_carry() -> void:
	if carry_id.is_empty() or not projection.views.has(carry_id):
		return
	var view: Node3D = projection.views[carry_id]
	view.global_position = camera.global_position - camera.global_basis.z * carry_distance
	view.rotation = Vector3(carry_pitch, carry_yaw, 0)
	view.scale = Vector3.ONE * carry_scale

func _update_target() -> void:
	var label: Label = $Interface/HUD/Target
	if not carry_id.is_empty():
		label.text = "Carrying / %s\n%.1f m / scale %.2f" % ["ROTATE" if rotate_mode else "MOVE", carry_distance, carry_scale]
		return
	var id: String = projection.pick(camera.global_position, -camera.global_basis.z)
	if id.is_empty():
		label.text = ""
		return
	var dims: Dictionary = projection.entities[id].get("dimensions", {})
	var name_value: String = str(dims.get("content.name", dims.get("entity.kind", "Object")))
	label.text = name_value.left(48) + (" / held" if dims.get("interaction.heldBy") != null else "\nRight click: carry / M: actions")

func _send_carry() -> void:
	if carry_id.is_empty() or not projection.entities.has(carry_id) or not projection.views.has(carry_id):
		return
	var dims: Dictionary = projection.entities[carry_id].get("dimensions", {})
	if dims.get("interaction.heldBy") != self_id:
		return
	var view: Node3D = projection.views[carry_id]
	_mutate({"op": "patch", "entityId": carry_id, "set": {"space.position": WorldProjection.array3(view.position), "space.yaw": carry_yaw, "space.pitch": carry_pitch, "space.scale": carry_scale}, "if": [{"dim": "interaction.heldBy", "eq": self_id}]})

func _rollback(id: String) -> void:
	if carry_id == id:
		carry_id = ""
		rotate_mode = false
	projection.restore(id)

func _mutate(mutation: Dictionary) -> bool:
	var command_id: String = _new_id("command")
	mutation["commandId"] = command_id
	pending[command_id] = {"op": mutation["op"], "entityId": mutation["entityId"], "time": Time.get_ticks_msec() * 0.001}
	var result: Dictionary = _command({"op": "send", "message": {"type": "space_mutate", "mutation": mutation}})
	if not result.get("ok", false):
		pending.erase(command_id)
		_rollback(str(mutation["entityId"]))
	return bool(result.get("ok", false))

func _new_id(_prefix: String) -> String:
	return str(bridge.call("new_id"))

func _place_box(at: Vector3, id: String = "") -> String:
	if id.is_empty():
		id = _new_id("box")
	var dimensions: Dictionary = {"entity.kind": "box", "space.position": WorldProjection.array3(at), "space.yaw": yaw, "space.pitch": 0.0, "space.scale": 1.0, "box.size": 1.0, "box.color": "#44aa88"}
	_mutate({"op": "create", "entityId": id, "dimensions": dimensions})
	return id

func _floor_target() -> Vector3:
	var direction: Vector3 = -camera.global_basis.z
	var distance: float = -camera.global_position.y / direction.y if direction.y < -0.05 else 3.0
	var at: Vector3 = camera.global_position + direction * clampf(distance, 0.5, 8)
	return Vector3(clampf(at.x, -23.0, 23.0), 0.0, clampf(at.z, -23.0, 23.0))

func _open_menu() -> void:
	menu_id = carry_id if not carry_id.is_empty() else projection.pick(camera.global_position, -camera.global_basis.z)
	if menu_id.is_empty():
		return
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	$Interface/Menu/Actions/Title.text = str(projection.entities[menu_id].get("dimensions", {}).get("entity.kind", "Object")) + "\n" + menu_id.left(8)
	menu.popup_centered()

func _menu_action(action: String) -> void:
	menu.hide()
	if not projection.entities.has(menu_id):
		return
	var dims: Dictionary = projection.entities[menu_id].get("dimensions", {})
	match action:
		"delete":
			_mutate({"op": "delete", "entityId": menu_id})
		"duplicate":
			_mutate({"op": "duplicate", "entityId": menu_id, "newEntityId": _new_id("copy")})
		"download":
			var cid: String = str(dims.get("content.cid", ""))
			if not cid.is_empty():
				_command({"op": "download", "cid": cid, "name": str(dims.get("content.name", cid))})
			else:
				_log("This object has no downloadable content")

func _files_dropped(paths: PackedStringArray) -> void:
	var index: int = 0
	for path: String in paths:
		if path.get_extension().to_lower() == "vrm":
			_avatar_path = path
			_avatar_reset_pending = false
			_submit_avatar()
		elif in_world:
			var at: Vector3 = _floor_target() + Vector3(index * 0.15, 0, 0)
			_command({"op": "drop", "path": path, "position": WorldProjection.array3(at), "yaw": yaw})
			index += 1
		else:
			_log("Connect before dropping world content")

func _reset_avatar() -> void:
	_avatar_path = ""
	_avatar_reset_pending = true
	_submit_avatar()
	if not in_world:
		_log("Avatar reset queued for the next connection")

func _submit_avatar() -> void:
	if not in_world:
		return
	if _avatar_reset_pending:
		var reset: Dictionary = _command({"op": "avatar", "cid": null})
		if reset.get("ok", false):
			_avatar_reset_pending = false
	elif not _avatar_path.is_empty() and _ipfs_ready:
		# Restore saved avatars in the native core; only upload an explicit CLI/drop override here.
		var path: String = _avatar_path
		_avatar_path = ""
		_command({"op": "avatar", "path": path})

func _automation(now: float) -> void:
	var elapsed: float = now - _entered
	var scenario: String = str(options.get("scenario", ""))
	if scenario.contains("walk"):
		var travel: float = sin(elapsed * 1.4) * 2.2
		var direction: float = cos(elapsed * 1.4)
		movement["position"] = [travel, 0.0, 2.0]
		yaw = PI * 0.5 if direction >= 0.0 else -PI * 0.5
		if _scenario_stage == 0:
			_emit({"event": "walk", "position": [travel, 0.0, 2.0]})
		_scenario_stage = 1
	if scenario.contains("place"):
		if _scenario_stage == 0:
			_scenario_id = _place_box(Vector3(0, 0.5, -2))
			_scenario_stage = 1
			_emit({"event": "scenario_created", "entityId": _scenario_id, "position": [0, 0.5, -2]})
		elif _scenario_stage == 1 and elapsed >= 2.0:
			_mutate({"op": "patch", "entityId": _scenario_id, "set": {"space.position": [2, 0.5, -2]}})
			_scenario_stage = 2
		elif _scenario_stage == 2 and elapsed >= 4.0:
			_mutate({"op": "delete", "entityId": _scenario_id})
			_scenario_stage = 3
	if options.has("screenshot") and elapsed >= float(options.get("screenshot-delay", 2.0)) and not _screenshot_started:
		_screenshot_started = true
		_screenshot()

func _capture_screenshot() -> void:
	var stamp: String = Time.get_datetime_string_from_system().replace(":", "-").replace("T", "_")
	var directory: String = "user://screenshots"
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(directory))
	_log("Screenshot saved: " + directory.path_join(stamp + ".png"))
	_screenshot(directory.path_join(stamp + ".png"))

func _screenshot(path_override: String = "") -> void:
	if DisplayServer.get_name() == "headless":
		_log("Screenshot requires a graphical rendering session, not --headless")
		_emit({"event": "screenshot_error", "message": "headless renderer"})
		return
	await RenderingServer.frame_post_draw
	var path: String = path_override
	if path.is_empty():
		path = "user://screenshot.png" if options["screenshot"] is bool else str(options["screenshot"])
	var image: Image = get_viewport().get_texture().get_image()
	var error: Error = image.save_png(path)
	_emit({"event": "screenshot" if error == OK else "screenshot_error", "path": ProjectSettings.globalize_path(path), "error": error})

func _finish_benchmark() -> void:
	_benchmark_done = true
	if _benchmark_samples.is_empty():
		_emit({"event": "benchmark_error", "message": "no samples"})
		_shutdown(1)
		return
	var total: float = 0.0
	var minimum: float = 1e9
	var maximum: float = 0.0
	for sample: float in _benchmark_samples:
		total += sample
		minimum = minf(minimum, sample)
		maximum = maxf(maximum, sample)
	var average: float = total / float(_benchmark_samples.size())
	_emit({"event": "benchmark", "quality": quality, "seconds": _benchmark_seconds,
		"samples": _benchmark_samples.size(), "avgFps": average, "minFps": minimum,
		"maxFps": maximum, "avgFrameMs": 1000.0 / maxf(average, 1.0)})
	_shutdown(0)

func _log(message: String) -> void:
	var display: String = message.replace("\n", " ")
	if display.length() > 220:
		display = display.left(217) + "..."
	_logs.append(display)
	while _logs.size() > 6:
		_logs.pop_front()
	log_label.text = "\n".join(_logs)
	status_label.text = display
	_emit({"event": "log", "message": message})

func _observe(event: Dictionary) -> void:
	if not _scenario_id.is_empty() and event.get("entityId") == _scenario_id:
		match str(event.get("event", "")):
			"node_created":
				_scenario_observed["created"] = true
			"node_updated":
				if WorldProjection.vec3(event.get("position")) == Vector3(2, 0.5, -2):
					_scenario_observed["moved"] = true
			"node_removed":
				_scenario_observed["removed"] = true
	_emit(event)

func _emit(event: Dictionary) -> void:
	print("PROTO_EVENT " + JSON.stringify(event))

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_shutdown(0)

func _shutdown(code: int) -> void:
	if _quitting:
		return
	_quitting = true
	if bridge != null:
		_command({"op": "disconnect"})
	_emit({"event": "exit", "code": code})
	get_tree().quit(code)
