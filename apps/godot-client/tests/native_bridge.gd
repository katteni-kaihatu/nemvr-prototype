extends SceneTree

var failures: Array[String] = []
var checks: int = 0


func _initialize() -> void:
	if not ClassDB.class_exists("ProtoClient"):
		push_error("ProtoClient extension is not loaded")
		quit(1)
		return
	var client: RefCounted = ClassDB.instantiate("ProtoClient")
	var config: Dictionary = client.command({"op": "config"})
	check(config.get("ok", false), "config crosses the native boundary")
	var rejected: Dictionary = client.command({"op": "unknown"})
	check(not rejected.get("ok", true), "invalid command rejected")
	var invalid_number: Dictionary = client.command({"op": "pose", "position": [NAN, 0, 0]})
	check(not invalid_number.get("ok", true), "non-finite number rejected")
	var invalid_type: Dictionary = client.command({"op": "pose", "position": Vector3.ZERO})
	check(not invalid_type.get("ok", true), "engine object types do not cross session boundary")
	var initial: Dictionary = {"position": [0.0, 0.0, 0.0], "grounded": true}
	var moved: Dictionary = client.step_movement(initial, {"moveZ": -1.0, "jump": true}, 1.0 / 60.0)
	check(float(moved.position[1]) > 0.0, "shared jump rule")
	check(float(moved.position[2]) < 0.0, "forward is -Z")
	check(int(moved.airJumps) == 1, "one air jump remains")
	var obstacle: Dictionary = {
		"id": "test-box", "version": 1,
		"dimensions": {"entity.kind": "box", "space.position": [0, 0, 0], "box.size": 1.0}
	}
	var resolved: Dictionary = client.resolve_collision(Vector3(0, 1.01, 0), 1.8, [obstacle])
	check(resolved.grounded, "shared collision recognises box top")
	check(absf(resolved.position.y - 1.0) < 0.02, "shared collision floor position")
	client.command({"op": "disconnect"})
	for failure: String in failures:
		push_error(failure)
	print("PROTO_TEST native_bridge checks=%d failures=%d" % [checks, failures.size()])
	quit(0 if failures.is_empty() else 1)


func check(condition: bool, message: String) -> void:
	checks += 1
	if not condition:
		failures.append(message)
