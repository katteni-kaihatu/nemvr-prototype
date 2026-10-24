extends SceneTree
var checks := 0
var failures := 0

func _check(condition: bool, label: String) -> void:
	checks += 1
	if not condition:
		failures += 1
		push_error("XR_TEST failed: " + label)

func _initialize() -> void:
	call_deferred("_run")

func _run() -> void:
	var world: Node3D = load("res://scenes/world.tscn").instantiate()
	root.add_child(world)
	var rig: Node3D = world.get_node("Player/XRRig")
	var desktop: Camera3D = world.get_node("Player/Camera")
	var xr_camera: XRCamera3D = world.get_node("Player/XRRig/XRCamera")
	_check(not xr_camera.current, "XR camera starts inactive")
	var active: bool = rig.call("activate", desktop, true)
	_check(active, "mock XR activates")
	_check(xr_camera.current, "XR camera becomes current")
	_check(not desktop.current, "desktop camera is disabled")
	_check(is_equal_approx(xr_camera.position.y, 1.6), "mock eye height")
	var left: Dictionary = rig.call("hand_pose", "left")
	var right: Dictionary = rig.call("hand_pose", "right")
	_check(left.get("tracked", false), "left mock hand tracked")
	_check(right.get("tracked", false), "right mock hand tracked")
	_check(float(left["position"][1]) > 1.0, "left hand height")
	rig.call("set_mock_input", Vector2(0.5, 0.8), true, true)
	_check((rig.call("get_move") as Vector2).is_equal_approx(Vector2(0.5, 0.8)), "mock stick input")
	_check(not is_zero_approx(float(rig.call("consume_snap_turn"))), "snap turn edge")
	_check(bool(rig.call("consume_grab")), "grab edge")
	rig.call("deactivate")
	_check(desktop.current, "desktop camera restores")
	_check(not xr_camera.current, "XR camera deactivates")
	print("XR_TEST " + JSON.stringify({"checks": checks, "failures": failures}))
	quit(0 if failures == 0 else 1)
