extends Node3D
## Fixed world plane: layer 4 never enters the reflected camera's cull mask.

var source: Camera3D
var viewport: SubViewport
var camera: Camera3D
var surface: MeshInstance3D

func _ready() -> void:
	position = Vector3(0, 1.4, -3.5)
	viewport = SubViewport.new()
	viewport.name = "ReflectionViewport"
	viewport.size = Vector2i(1024, 1024)
	viewport.render_target_update_mode = SubViewport.UPDATE_DISABLED
	viewport.world_3d = get_viewport().world_3d
	add_child(viewport)
	camera = Camera3D.new()
	camera.name = "ReflectedCamera"
	camera.cull_mask = 3
	viewport.add_child(camera)
	surface = MeshInstance3D.new()
	surface.name = "MirrorPlane"
	surface.layers = 4
	var mesh: QuadMesh = QuadMesh.new()
	mesh.size = Vector2(2.4, 2.6)
	surface.mesh = mesh
	var shader: Shader = Shader.new()
	shader.code = "shader_type spatial; render_mode unshaded, cull_disabled; uniform sampler2D reflection; void fragment(){ ALBEDO = texture(reflection, vec2(1.0-SCREEN_UV.x, SCREEN_UV.y)).rgb; }"
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = shader
	material.set_shader_parameter("reflection", viewport.get_texture())
	surface.material_override = material
	add_child(surface)
	var frame: MeshInstance3D = MeshInstance3D.new()
	var frame_mesh: BoxMesh = BoxMesh.new()
	frame_mesh.size = Vector3(2.55, 2.75, 0.07)
	frame.mesh = frame_mesh
	frame.position.z = -0.05
	frame.layers = 4
	var frame_material: StandardMaterial3D = StandardMaterial3D.new()
	frame_material.albedo_color = Color(0.08, 0.12, 0.14)
	frame.material_override = frame_material
	add_child(frame)

func set_enabled(enabled: bool) -> void:
	visible = enabled
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS if enabled else SubViewport.UPDATE_DISABLED

func _process(_delta: float) -> void:
	if not visible or source == null:
		return
	var normal: Vector3 = global_basis.z.normalized()
	var origin: Vector3 = source.global_position
	var reflected: Vector3 = origin - 2.0 * normal * normal.dot(origin - global_position)
	var forward: Vector3 = -source.global_basis.z
	var up: Vector3 = source.global_basis.y
	forward -= 2.0 * normal * normal.dot(forward)
	up -= 2.0 * normal * normal.dot(up)
	camera.global_position = reflected
	camera.look_at(reflected + forward, up)
	camera.fov = source.fov
	camera.near = maxf(0.05, absf(normal.dot(origin - global_position)) * 0.85)
	camera.far = source.far
	viewport.size = Vector2i(get_viewport().get_visible_rect().size)
