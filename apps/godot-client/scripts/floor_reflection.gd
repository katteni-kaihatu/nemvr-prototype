extends Node3D
## Planar floor reflection. Renders the world from a camera mirrored across y=0
## and feeds the result to the floor shader through screen UV.

const MIRROR_FLOOR_SHADER: Shader = preload("res://shaders/mirror_floor.gdshader")

@export var source: Camera3D
var viewport: SubViewport
var camera: Camera3D
var material: ShaderMaterial
var enabled: bool = true
var resolution_scale: float = 1.0

func _ready() -> void:
	viewport = SubViewport.new()
	viewport.name = "FloorReflectionViewport"
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	viewport.world_3d = get_viewport().world_3d
	add_child(viewport)
	camera = Camera3D.new()
	camera.name = "ReflectedFloorCamera"
	# World objects only: exclude the floor (layer 6), self avatar, and the wall mirror.
	camera.cull_mask = 1
	camera.fov = 75.0
	camera.near = 0.05
	camera.far = 150.0
	viewport.add_child(camera)
	var floor: MeshInstance3D = get_parent().get_node_or_null("Floor")
	if floor != null and floor.material_override is ShaderMaterial:
		material = floor.material_override
		material.set_shader_parameter("reflection", viewport.get_texture())
		material.set_shader_parameter("reflection_strength", 0.55)
		# The wall mirror must show a floor, but the reflective floor would sample
		# the main camera's reflection texture from the mirror viewport. Give the
		# mirror camera a separate, non-reflective floor on the self layer (2).
		var proxy: MeshInstance3D = MeshInstance3D.new()
		proxy.name = "MirrorFloor"
		var mesh: PlaneMesh = PlaneMesh.new()
		mesh.size = Vector2(96, 96)
		proxy.mesh = mesh
		proxy.layers = 2
		var proxy_material: ShaderMaterial = ShaderMaterial.new()
		proxy_material.shader = MIRROR_FLOOR_SHADER
		proxy.material_override = proxy_material
		add_child.call_deferred(proxy)

func set_enabled(value: bool) -> void:
	enabled = value
	if viewport != null:
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS if enabled else SubViewport.UPDATE_DISABLED
	if material != null:
		material.set_shader_parameter("reflection_strength", 0.55 if enabled else 0.0)

func set_quality(level: String) -> void:
	match level:
		"low":
			resolution_scale = 0.0
			set_enabled(false)
		"medium":
			resolution_scale = 0.6
			set_enabled(true)
		_:
			resolution_scale = 1.0
			set_enabled(true)

func _process(_delta: float) -> void:
	if not enabled or source == null:
		return
	var origin: Vector3 = source.global_position
	var forward: Vector3 = -source.global_basis.z
	var up: Vector3 = source.global_basis.y
	var mirrored_origin: Vector3 = Vector3(origin.x, -origin.y, origin.z)
	var mirrored_forward: Vector3 = Vector3(forward.x, -forward.y, forward.z)
	var mirrored_up: Vector3 = Vector3(up.x, -up.y, up.z)
	camera.global_position = mirrored_origin
	camera.look_at(mirrored_origin + mirrored_forward, mirrored_up)
	camera.fov = source.fov
	camera.near = maxf(0.05, origin.y * 0.5)
	camera.far = source.far
	if material != null:
		material.set_shader_parameter("reflection_view", camera.global_transform.affine_inverse())
		material.set_shader_parameter("reflection_projection", camera.get_camera_projection())
	var size: Vector2 = get_viewport().get_visible_rect().size
	viewport.size = Vector2i(
		maxi(int(size.x * resolution_scale), 320),
		maxi(int(size.y * resolution_scale), 180))
