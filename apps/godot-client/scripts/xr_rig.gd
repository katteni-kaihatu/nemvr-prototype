extends Node3D
## Optional OpenXR origin. Desktop mode leaves this node inactive.

var desktop_camera: Camera3D
var xr_camera: XRCamera3D
var left_hand: XRController3D
var right_hand: XRController3D
var active: bool = false
var mock: bool = false

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
	active = true
	xr_camera.current = true
	desktop_camera.current = false
	return true

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
	if xr_camera != null:
		xr_camera.current = false
	if desktop_camera != null:
		desktop_camera.current = true
