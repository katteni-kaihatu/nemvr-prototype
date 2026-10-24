extends Node3D
## Optional OpenXR origin. Desktop mode leaves this node inactive.

var desktop_camera: Camera3D
var xr_camera: XRCamera3D
var active: bool = false
var mock: bool = false

func _ready() -> void:
	xr_camera = get_node_or_null("XRCamera") as XRCamera3D

func activate(desktop: Camera3D, use_mock: bool = false) -> bool:
	desktop_camera = desktop
	mock = use_mock
	if use_mock:
		active = true
		xr_camera.current = true
		desktop_camera.current = false
		xr_camera.position = Vector3(0, 1.6, 0)
		xr_camera.rotation_degrees = Vector3(0, 20, 0)
		return true
	var interface := XRServer.find_interface("OpenXR")
	if interface == null or not interface.is_initialized() and not interface.initialize():
		return false
	get_viewport().use_xr = true
	active = true
	xr_camera.current = true
	desktop_camera.current = false
	return true

func deactivate() -> void:
	active = false
	mock = false
	get_viewport().use_xr = false
	if xr_camera != null:
		xr_camera.current = false
	if desktop_camera != null:
		desktop_camera.current = true
