extends Node3D

signal action(name: String)

const BUTTONS := [["box", "Box"], ["mirror", "Mirror"], ["mic", "Mic"], ["close", "Close"]]
var _buttons: Array[Dictionary] = []

func _ready() -> void:
	var panel_material := StandardMaterial3D.new()
	panel_material.albedo_color = Color(0.04, 0.08, 0.10, 0.94)
	panel_material.emission_enabled = true
	panel_material.emission = Color(0.02, 0.10, 0.12)
	panel_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_box(Vector3(0.92, 0.42, 0.025), Vector3.ZERO, panel_material)
	for index in BUTTONS.size():
		var key: String = BUTTONS[index][0]
		var label: String = BUTTONS[index][1]
		var x: float = -0.33 + index * 0.22
		var material := StandardMaterial3D.new()
		material.albedo_color = Color(0.10, 0.28, 0.30)
		material.emission_enabled = true
		material.emission = Color(0.08, 0.35, 0.36)
		material.emission_energy_multiplier = 0.8
		var node: MeshInstance3D = _box(Vector3(0.20, 0.18, 0.02), Vector3(x, 0, 0.02), material)
		var text := Label3D.new()
		text.text = label
		text.font_size = 20
		text.pixel_size = 0.0025
		text.position = Vector3(x, 0, 0.035)
		text.no_depth_test = true
		add_child(text)
		_buttons.append({"name": key, "node": node})

func _box(size: Vector3, at: Vector3, material: StandardMaterial3D) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	node.mesh = mesh
	node.position = at
	node.material_override = material
	add_child(node)
	return node

func pick(origin: Vector3, direction: Vector3, distance: float = 3.0) -> String:
	for button: Dictionary in _buttons:
		var node: MeshInstance3D = button["node"]
		var local_origin: Vector3 = node.to_local(origin)
		var local_end: Vector3 = node.to_local(origin + direction * distance)
		var half: Vector3 = (node.mesh as BoxMesh).size * 0.5
		var hit: Variant = AABB(-half, half * 2.0).intersects_segment(local_origin, local_end)
		if hit is Vector3:
			return str(button["name"])
	return ""
