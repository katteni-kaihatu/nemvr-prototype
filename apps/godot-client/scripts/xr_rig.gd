extends Node3D
## Optional OpenXR origin. Desktop mode leaves this node inactive.

var desktop_camera: Camera3D
var xr_camera: XRCamera3D
var left_hand: XRController3D
var right_hand: XRController3D
var active: bool = false
var mock: bool = false
var move_input: Vector2 = Vector2.ZERO
var turn_input: float = 0.0
var snap_turn: float = 0.0
var grab_requested: bool = false
var teleport_requested: bool = false
var menu_requested: bool = false
var _right_zone: int = 0
var _grab_was: bool = false
var _teleport_was: bool = false
var _menu_was: bool = false

func _ready() -> void:
	xr_camera = get_node_or_null("XRCamera") as XRCamera3D
	left_hand = get_node_or_null("LeftHand") as XRController3D
	right_hand = get_node_or_null("RightHand") as XRController3D

func activate(desktop: Camera3D, use_mock: bool = false) -> bool:
	desktop_camera = desktop
	mock = use_mock
	if use_mock:
		active = true
		xr_camera.current = true
		desktop_camera.current = false
		xr_camera.position = Vector3(0, 1.6, 0)
		xr_camera.rotation_degrees = Vector3(0, 20, 0)
		if left_hand != null:
			left_hand.position = Vector3(-0.25, 1.25, 0.35)
			left_hand.rotation = Vector3(-0.2, 0.2, 0.0)
		if right_hand != null:
			right_hand.position = Vector3(0.25, 1.25, 0.35)
			right_hand.rotation = Vector3(-0.2, -0.2, 0.0)
		return true
	var interface := XRServer.find_interface("OpenXR")
	if interface == null or not interface.is_initialized() and not interface.initialize():
		return false
	get_viewport().use_xr = true
	if interface.has_method("set_play_area_mode"):
		interface.set_play_area_mode(XRInterface.XR_PLAY_AREA_STAGE)
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	var viewport: Viewport = get_viewport()
	viewport.scaling_3d_scale = 1.0
	if RenderingServer.get_rendering_device():
		viewport.vrs_mode = Viewport.VRS_XR
	active = true
	xr_camera.current = true
	desktop_camera.current = false
	return true

func is_grip_held() -> bool:
	return not mock and right_hand != null and right_hand.get_float("grip") > 0.5

func get_move() -> Vector2:
	return move_input

func get_turn() -> float:
	return turn_input if absf(turn_input) > 0.12 else 0.0

func consume_snap_turn() -> float:
	var value: float = snap_turn
	snap_turn = 0.0
	return value

func consume_grab() -> bool:
	var value: bool = grab_requested
	grab_requested = false
	return value

func consume_menu() -> bool:
	var value: bool = menu_requested
	menu_requested = false
	return value

func consume_teleport() -> bool:
	var value: bool = teleport_requested
	teleport_requested = false
	return value

func set_mock_input(move: Vector2, turn: bool, grab: bool) -> void:
	move_input = move
	if turn:
		snap_turn = PI * 0.5
	if grab:
		grab_requested = true

func hand_ray(side: String) -> Array:
	var node: XRController3D = left_hand if side == "left" else right_hand
	if node == null:
		return [Vector3.ZERO, Vector3.FORWARD]
	return [node.global_position, -node.global_basis.z]

func _process(_delta: float) -> void:
	if not active or mock or left_hand == null or right_hand == null:
		return
	move_input = left_hand.get_vector2("move")
	turn_input = right_hand.get_vector2("turn").x
	var turn: float = turn_input
	var zone: int = 1 if turn > 0.7 else (-1 if turn < -0.7 else 0)
	if zone != 0 and zone != _right_zone:
		snap_turn = -float(zone) * PI * 0.5
	_right_zone = zone
	var grab: bool = right_hand.is_button_pressed("grab")
	if grab and not _grab_was:
		grab_requested = true
	_grab_was = grab
	var teleport: bool = left_hand.is_button_pressed("teleport")
	if teleport and not _teleport_was:
		teleport_requested = true
	_teleport_was = teleport
	var menu: bool = left_hand.is_button_pressed("menu")
	if menu and not _menu_was:
		menu_requested = true
	_menu_was = menu

func hand_pose(side: String) -> Dictionary:
	var node: XRController3D = left_hand if side == "left" else right_hand
	if not active or node == null:
		return {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0], "tracked": false}
	var rotation: Quaternion = node.global_basis.get_rotation_quaternion()
	return {"position": [node.global_position.x, node.global_position.y, node.global_position.z],
		"rotation": [rotation.x, rotation.y, rotation.z, rotation.w], "tracked": true}

func deactivate() -> void:
	active = false
	mock = false
	get_viewport().use_xr = false
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_ENABLED)
	get_viewport().vrs_mode = Viewport.VRS_DISABLED
	if xr_camera != null:
		xr_camera.current = false
	if desktop_camera != null:
		desktop_camera.current = true
