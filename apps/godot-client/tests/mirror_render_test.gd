extends SceneTree
## Graphical pixel test, deliberately not a headless rendering substitute.

const Mirror = preload("res://scripts/mirror.gd")
var failures: int = 0

func _initialize() -> void:
	_run.call_deferred()

func _check(value: bool, message: String) -> void:
	if not value:
		failures += 1
		push_error(message)

func _marker(world: Node3D, at: Vector3, color: Color) -> void:
	var node: MeshInstance3D = MeshInstance3D.new()
	var mesh: BoxMesh = BoxMesh.new()
	mesh.size = Vector3(0.45, 0.45, 0.1)
	node.mesh = mesh
	node.position = at
	node.layers = 2
	var material: StandardMaterial3D = StandardMaterial3D.new()
	material.albedo_color = color
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	node.material_override = material
	world.add_child(node)

func _pixels(image: Image) -> Dictionary:
	var red_count: int = 0
	var blue_count: int = 0
	var red_x: float = 0
	var blue_x: float = 0
	for y: int in range(image.get_height()):
		for x: int in range(image.get_width()):
			var color: Color = image.get_pixel(x, y)
			if color.r > 0.7 and color.g < 0.25 and color.b < 0.25:
				red_count += 1
				red_x += x
			if color.b > 0.7 and color.r < 0.25 and color.g < 0.25:
				blue_count += 1
				blue_x += x
	return {"red": red_count, "blue": blue_count, "redX": red_x / maxf(red_count, 1), "blueX": blue_x / maxf(blue_count, 1)}

func _frame() -> void:
	await process_frame
	await RenderingServer.frame_post_draw

func _run() -> void:
	if DisplayServer.get_name() == "headless":
		push_error("mirror_render_test requires a graphical display")
		quit(2)
		return
	root.size = Vector2i(1280, 720)
	var world: Node3D = load("res://scenes/world.tscn").instantiate()
	root.add_child(world)
	var camera: Camera3D = world.get_node("Player/Camera")
	var mirror: Mirror = Mirror.new()
	world.add_child(mirror)
	mirror.source = camera
	_marker(world, Vector3(-0.8, 1.6, 0.5), Color.RED)
	_marker(world, Vector3(0.8, 1.6, 0.5), Color.BLUE)
	mirror.set_enabled(true)
	await _frame()
	await _frame()
	await _frame()
	var image: Image = root.get_texture().get_image()
	var enabled: Dictionary = _pixels(image)
	_check(enabled["red"] > 25 and enabled["blue"] > 25, "Mirror must render both mirror-only color markers")
	_check(enabled["redX"] < enabled["blueX"], "Reflection must preserve the physical plane's left/right positions")
	image.save_png("/tmp/kilo/godot-mirror-test.png")
	var fixed: Transform3D = mirror.global_transform
	camera.position.x = 0.6
	await _frame()
	await _frame()
	_check(mirror.global_transform == fixed, "Mirror must not follow camera movement")
	_check(absf(mirror.camera.global_position.x - camera.global_position.x) < 0.001, "Reflected camera must track the reflected source position")
	mirror.set_enabled(false)
	await _frame()
	await _frame()
	var disabled: Dictionary = _pixels(root.get_texture().get_image())
	_check(disabled["red"] == 0 and disabled["blue"] == 0, "Mirror-only objects must not leak into ordinary first-person rendering")
	print("PROTO_EVENT " + JSON.stringify({"event": "mirror_render_tests", "failures": failures, "enabled": enabled, "disabled": disabled}))
	world.queue_free()
	await process_frame
	quit(0 if failures == 0 else 1)
