extends Node3D
## Built-in vr-sns-3d@1 display adapter, never the authoritative space store.

signal asset_requested(cid: String)
signal observed(event: Dictionary)
signal notice(message: String)

const SELF_LAYER: int = 2
const WORLD_LAYER: int = 1
const AVATAR_LOADER: String = "res://native/runtime_avatar.gd"
const ENTITY_SHADER: Shader = preload("res://shaders/entity_surface.gdshader")

var entities: Dictionary = {}
var views: Dictionary = {}
var self_id: String = ""
var font: Font
var image_decoder: Object
var _samples: Dictionary = {}
var _self_motion_time: float = 0.0
var _assets: Dictionary = {}
var _requested: Dictionary = {}
var _asset_attempts: Dictionary = {}
var _name_labels: Dictionary = {}
var _peer_names: Dictionary = {}
var _fallback_phase: Dictionary = {}
var hand_ik_enabled: bool = false
var _loader: Object

func apply_snapshot(snapshot: Array, own_id: String) -> void:
	self_id = own_id
	var incoming: Dictionary = {}
	for value: Variant in snapshot:
		if not value is Dictionary:
			continue
		var entity: Dictionary = value
		var id: String = str(entity.get("id", ""))
		if id.is_empty():
			continue
		incoming[id] = entity.duplicate(true)
	for id: String in entities.keys():
		if not incoming.has(id):
			_remove(id)
			entities.erase(id)
	for id: String in incoming:
		var entity: Dictionary = incoming[id]
		var changed: bool = not entities.has(id) or entities[id] != entity
		entities[id] = entity
		if changed:
			_update(id, entity)

func clear() -> void:
	for id: String in views.keys():
		_remove(id)
	entities.clear()
	_samples.clear()
	_requested.clear()
	self_id = ""

func restore(id: String) -> void:
	if entities.has(id):
		_update(id, entities[id])

func _remove(id: String) -> void:
	if views.has(id):
		var node: Node3D = views[id]
		observed.emit({"event": "node_removed", "entityId": id, "nodePath": str(node.get_path())})
		node.queue_free()
		views.erase(id)
	_samples.erase(id)
	_fallback_phase.erase(id)

func _update(id: String, entity: Dictionary) -> void:
	var dims: Dictionary = entity.get("dimensions", {})
	var kind: String = str(dims.get("entity.kind", ""))
	if kind not in ["peer", "box", "image", "file", "link"]:
		_remove(id)
		return
	var created: bool = not views.has(id)
	var root: Node3D
	if created:
		root = Node3D.new()
		root.name = "Entity_" + id.validate_node_name()
		add_child(root)
		views[id] = root
	else:
		root = views[id]
	var visual_key: Dictionary = dims.duplicate(true)
	for key: String in ["space.position", "space.head", "space.yaw", "space.pitch", "space.scale", "space.crouch", "space.lean", "interaction.heldBy"]:
		visual_key.erase(key)
	for key: String in visual_key.keys():
		if key.begins_with("time.") or key.begins_with("space.xr."):
			visual_key.erase(key)
	if created or root.get_meta("visual_key", {}) != visual_key:
		for child: Node in root.get_children():
			root.remove_child(child)
			child.queue_free()
		root.set_meta("visual_key", visual_key)
		_build(root, dims, kind, id)
	var position_value: Vector3 = vec3(dims.get("space.position", [0, 0, 0]))
	if kind == "peer":
		var samples: Array = _samples.get(id, [])
		samples.append({"time": Time.get_ticks_msec() * 0.001, "position": position_value,
			"head": quat(dims.get("space.head", [0, 0, 0, 1])), "crouch": float(dims.get("space.crouch", 0)), "lean": float(dims.get("space.lean", 0))})
		while samples.size() > 32:
			samples.pop_front()
		_samples[id] = samples
		if created:
			root.position = position_value
		_set_layers(root, SELF_LAYER if id == self_id else WORLD_LAYER)
		var animator: Node = root.get_node_or_null("Avatar/AvatarAnimator")
		if hand_ik_enabled and animator != null and animator.has_method("set_hand_targets"):
			animator.call("set_hand_targets",
				vec3(dims.get("space.xr.left.position", [0, 0, 0])),
				vec3(dims.get("space.xr.right.position", [0, 0, 0])),
				bool(dims.get("space.xr.left.tracked", false)),
				bool(dims.get("space.xr.right.tracked", false)))
		for side: String in ["left", "right"]:
			var hand: Node3D = root.get_node_or_null(side.capitalize() + "Hand")
			if hand == null:
				continue
			var tracked: bool = bool(dims.get("space.xr.%s.tracked" % side, false))
			hand.visible = tracked
			if tracked:
				hand.global_transform = Transform3D(Basis(quat(dims.get("space.xr.%s.rotation" % side, [0, 0, 0, 1]))),
					vec3(dims.get("space.xr.%s.position" % side, [0, 0, 0])))
	else:
		root.position = position_value
		root.rotation = Vector3(float(dims.get("space.pitch", 0)), float(dims.get("space.yaw", 0)), 0)
		root.scale = Vector3.ONE * clampf(float(dims.get("space.scale", 1)), 0.01, 100)
	observed.emit({"event": "node_created" if created else "node_updated", "entityId": id,
		"position": array3(root.position), "nodePath": str(root.get_path()), "kind": kind, "version": entity.get("version", 0)})

func _build(root: Node3D, dims: Dictionary, kind: String, id: String) -> void:
	match kind:
		"peer":
			var cid: String = str(dims.get("peer.avatarCid", "") if dims.get("peer.avatarCid") != null else "")
			var avatar: Node3D = _avatar(cid)
			if avatar != null:
				avatar.name = "Avatar"
				# Cancel the importer's extra 180° yaw; peer yaw is applied on the root.
				avatar.rotation.y = 0.0
				root.add_child(avatar)
			else:
				var color: Color = Color.from_string(str(dims.get("peer.color", "#78bbaa")), Color.SEA_GREEN)
				_box(root, Vector3(0.38, 0.65, 0.24), Vector3(0, 1.02, 0), color)
				var head: MeshInstance3D = _box(root, Vector3(0.27, 0.28, 0.26), Vector3(0, 1.53, 0), color.lightened(0.2))
				head.name = "Head"
				for side: float in [-1.0, 1.0]:
					var arm: MeshInstance3D = _box(root, Vector3(0.13, 0.6, 0.15), Vector3(side * 0.28, 1.03, 0), color)
					arm.name = "LeftArm" if side < 0.0 else "RightArm"
					var leg: MeshInstance3D = _box(root, Vector3(0.15, 0.65, 0.17), Vector3(side * 0.12, 0.35, 0), color.darkened(0.2))
					leg.name = "LeftLeg" if side < 0.0 else "RightLeg"
				for hand_name: String in ["LeftHand", "RightHand"]:
					var hand: MeshInstance3D = _box(root, Vector3(0.09, 0.09, 0.15), Vector3.ZERO, Color(0.72, 0.9, 1.0))
					hand.name = hand_name
					hand.visible = false
			var peer_name: String = str(dims.get("peer.name", "Guest"))
			_peer_names[id] = peer_name
			_name_labels[id] = _label(root, peer_name, Vector3(0, 1.95, 0))
		"box":
			var size: float = clampf(float(dims.get("box.size", 1)), 0.01, 100)
			_box(root, Vector3.ONE * size, Vector3(0, size * 0.5, 0), Color.from_string(str(dims.get("box.color", "#888888")), Color.GRAY))
		"image":
			var width: float = clampf(float(dims.get("content.width", 1)), 0.1, 20)
			var height: float = clampf(float(dims.get("content.height", 1)), 0.1, 20)
			_box(root, Vector3(width + 0.085, height + 0.085, 0.045), Vector3(0, height * 0.5, -0.028),
				Color(0.06, 0.16, 0.18))
			var panel: MeshInstance3D = MeshInstance3D.new()
			var mesh: QuadMesh = QuadMesh.new()
			mesh.size = Vector2(width, height)
			panel.mesh = mesh
			panel.position.y = height * 0.5
			root.add_child(panel)
			var cid: String = str(dims.get("content.cid", ""))
			if _assets.has(cid):
				var image: Image = _decode_image(str(_assets[cid]))
				if image != null:
					var material: StandardMaterial3D = StandardMaterial3D.new()
					material.albedo_texture = ImageTexture.create_from_image(image)
					material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
					material.cull_mode = BaseMaterial3D.CULL_DISABLED
					material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
					material.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
					panel.material_override = material
				else:
					_label(root, "Image decode failed", Vector3(0, height * 0.5, 0.05))
					notice.emit("Image decode failed: " + cid)
			else:
				_request(cid)
				_label(root, "Image / loading", Vector3(0, height * 0.5, 0.05))
		"file", "link":
			_box(root, Vector3(0.9, 1.2, 0.06), Vector3(0, 0.6, 0), Color(0.16, 0.28, 0.34) if kind == "file" else Color(0.25, 0.24, 0.40))
			var text: String = str(dims.get("content.name", "File")) if kind == "file" else str(dims.get("content.url", "Link"))
			if kind == "file":
				text += "\n" + str(dims.get("content.size", 0)) + " bytes"
				if dims.get("content.offline", false):
					text += " / offline"
				elif dims.get("content.stored", false):
					text += " / stored"
			_label(root, text.left(180), Vector3(0, 0.6, 0.05), false)

func _decode_image(path: String) -> Image:
	# The native decoder sniffs extensionless CID bytes and checks allocation budgets
	# before decoding. It also provides the GIF first-frame support of the Bevy client.
	if image_decoder == null:
		return null
	var result: Dictionary = image_decoder.call("decode_image", ProjectSettings.globalize_path(path))
	if not result.get("ok", false):
		notice.emit(str(result.get("error", "Image decode failed")))
		return null
	return Image.create_from_data(int(result.width), int(result.height), false, Image.FORMAT_RGBA8, result.rgba)

func _box(parent: Node3D, size: Vector3, at: Vector3, color: Color) -> MeshInstance3D:
	var node: MeshInstance3D = MeshInstance3D.new()
	var mesh: BoxMesh = BoxMesh.new()
	mesh.size = size
	node.mesh = mesh
	node.position = at
	var material: ShaderMaterial = ShaderMaterial.new()
	material.shader = ENTITY_SHADER
	material.set_shader_parameter("albedo", color)
	material.set_shader_parameter("smoothness", 0.5)
	material.set_shader_parameter("rim_strength", 0.6)
	node.material_override = material
	parent.add_child(node)
	return node

func _label(parent: Node3D, text: String, at: Vector3, billboard: bool = true) -> Label3D:
	var node: Label3D = Label3D.new()
	node.text = text
	node.position = at
	node.font_size = 38
	node.pixel_size = 0.004
	node.outline_size = 8
	node.width = 280
	node.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	if font != null:
		node.font = font
	if billboard:
		node.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	parent.add_child(node)
	return node

func set_speakers(ids: Array) -> void:
	for id: String in _name_labels:
		var label: Label3D = _name_labels[id]
		if not is_instance_valid(label):
			continue
		var speaking: bool = ids.has(id)
		label.text = ("● " if speaking else "") + str(_peer_names.get(id, "Guest"))
		label.modulate = Color(0.55, 1.0, 0.85) if speaking else Color.WHITE

func _request(cid: String) -> void:
	if cid.is_empty() or _assets.has(cid) or _requested.has(cid):
		return
	_requested[cid] = true
	_asset_attempts[cid] = int(_asset_attempts.get(cid, 0)) + 1
	asset_requested.emit(cid)

func asset_failed(cid: String) -> void:
	if cid.is_empty() or _assets.has(cid):
		return
	_requested.erase(cid)
	if int(_asset_attempts.get(cid, 0)) >= 3:
		notice.emit("Content fetch failed after retries: " + cid)
		return
	notice.emit("Content fetch retry: " + cid)
	await get_tree().create_timer(1.0).timeout
	_request(cid)

func asset_ready(cid: String, path: String) -> void:
	_assets[cid] = path
	for id: String in entities:
		var dims: Dictionary = entities[id].get("dimensions", {})
		if dims.get("content.cid") == cid or dims.get("peer.avatarCid") == cid:
			if views.has(id):
				views[id].set_meta("visual_key", {})
			_update(id, entities[id])

func _avatar(cid: String) -> Node3D:
	if cid.is_empty():
		return null
	if not _assets.has(cid):
		_request(cid)
		return null
	# Only this bundled, trusted loader is instantiated. Cached user scripts/resources are never loaded.
	if _loader == null and ResourceLoader.exists(AVATAR_LOADER):
		var script: Script = load(AVATAR_LOADER) as Script
		if script != null:
			_loader = script.new()
	if _loader != null and _loader.has_method("load_vrm"):
		var avatar: Node3D = _loader.call("load_vrm", str(_assets[cid])) as Node3D
		if avatar == null:
			var reason: String = str(_loader.call("diagnostic")) if _loader.has_method("diagnostic") else "unsupported or invalid model"
			notice.emit("Avatar fallback: " + reason)
		return avatar
	notice.emit("Avatar fallback: bundled runtime importer unavailable")
	return null

func _set_layers(node: Node, layer: int) -> void:
	if node is VisualInstance3D:
		(node as VisualInstance3D).layers = layer
	for child: Node in node.get_children():
		_set_layers(child, layer)

func _process(_delta: float) -> void:
	var at: float = Time.get_ticks_msec() * 0.001 - 0.1
	for id: String in _samples:
		if id == self_id or not views.has(id):
			continue
		var samples: Array = _samples[id]
		while samples.size() > 2 and float(samples[1]["time"]) <= at:
			samples.pop_front()
		var a: Dictionary = samples[0]
		var b: Dictionary = samples[1] if samples.size() > 1 else a
		var span: float = float(b["time"]) - float(a["time"])
		var weight: float = clampf((at - float(a["time"])) / span, 0, 1) if span > 0 else 1
		var node: Node3D = views[id]
		node.position = (a["position"] as Vector3).lerp(b["position"], weight)
		var head: Quaternion = (a["head"] as Quaternion).slerp(b["head"], weight)
		node.rotation.y = head.get_euler().y
		var head_node: Node3D = node.get_node_or_null("Head")
		if head_node != null:
			head_node.rotation.x = head.get_euler().x
		var crouch: float = lerpf(float(a["crouch"]), float(b["crouch"]), weight)
		var motion_speed: float = (b["position"] as Vector3).distance_to(a["position"]) / span if span > 0.0 else 0.0
		var avatar: Node = node.get_node_or_null("Avatar")
		if avatar == null:
			node.scale.y = 1.0 - crouch * 0.4
		else:
			node.scale.y = 1.0
			_animate_avatar(node, motion_speed, crouch)

func update_self(position_value: Vector3, yaw: float, crouch: float, lean: float, pitch: float = 0.0) -> void:
	if views.has(self_id):
		var node: Node3D = views[self_id]
		var now: float = Time.get_ticks_msec() * 0.001
		var elapsed: float = maxf(now - _self_motion_time, 0.001)
		var motion_speed: float = node.position.distance_to(position_value) / elapsed
		_self_motion_time = now
		node.position = position_value
		node.rotation = Vector3(0, yaw, lean * 0.3)
		if node.get_node_or_null("Avatar") == null:
			_animate_fallback(self_id, node, motion_speed, crouch)
		else:
			node.scale.y = 1.0
			_animate_avatar(node, motion_speed, crouch)
		var head: Node3D = node.get_node_or_null("Head")
		if head != null:
			head.rotation.x = pitch


func _animate_fallback(id: String, root: Node3D, speed: float, crouch: float) -> void:
	var phase: float = float(_fallback_phase.get(id, 0.0)) + (0.35 + speed * 1.7) * get_process_delta_time()
	_fallback_phase[id] = phase
	var walk: float = clampf(speed / 1.6, 0.0, 1.0)
	var swing: float = sin(phase) * walk
	root.scale.y = 1.0 - crouch * 0.35
	var left_arm: Node3D = root.get_node_or_null("LeftArm")
	var right_arm: Node3D = root.get_node_or_null("RightArm")
	var left_leg: Node3D = root.get_node_or_null("LeftLeg")
	var right_leg: Node3D = root.get_node_or_null("RightLeg")
	if left_arm != null:
		left_arm.rotation.x = -swing * 0.7
	if right_arm != null:
		right_arm.rotation.x = swing * 0.7
	if left_leg != null:
		left_leg.rotation.x = swing * 0.65
	if right_leg != null:
		right_leg.rotation.x = -swing * 0.65
	var head: Node3D = root.get_node_or_null("Head")
	if head != null:
		head.rotation.x = -crouch * 0.25 + sin(phase * 0.5) * 0.03
		head.rotation.y = sin(phase * 0.37) * 0.06

func _animate_avatar(root: Node3D, speed: float, crouch: float) -> void:
	var animator: Node = root.get_node_or_null("Avatar/AvatarAnimator")
	if animator != null and animator.has_method("set_motion"):
		animator.call("set_motion", speed, crouch)

func floor_hit(origin: Vector3, direction: Vector3, distance: float = 30.0) -> Dictionary:
	if absf(direction.y) < 0.0001:
		return {"hit": false}
	var t: float = -origin.y / direction.y
	if t < 0.0 or t > distance:
		return {"hit": false}
	var point: Vector3 = origin + direction * t
	if absf(point.x) > 24.0 or absf(point.z) > 24.0:
		return {"hit": false}
	return {"hit": true, "position": point}

func pick_hit(origin: Vector3, direction: Vector3, distance: float = 10.0) -> Dictionary:
	var chosen: String = ""
	var nearest: float = distance
	var point: Vector3 = origin + direction * distance
	for id: String in views:
		var dims: Dictionary = entities[id].get("dimensions", {})
		if dims.get("entity.kind") == "peer":
			continue
		var node: Node3D = views[id]
		var extent: Vector3 = Vector3(0.45, 0.6, 0.03)
		if dims.get("entity.kind") == "box":
			extent = Vector3.ONE * float(dims.get("box.size", 1)) * 0.5
		elif dims.get("entity.kind") == "image":
			extent = Vector3(float(dims.get("content.width", 1)) * 0.5, float(dims.get("content.height", 1)) * 0.5, 0.03)
		var center: Vector3 = Vector3(0, extent.y, 0)
		var local_origin: Vector3 = node.to_local(origin)
		var local_end: Vector3 = node.to_local(origin + direction * distance)
		var hit: Variant = AABB(center - extent, extent * 2).intersects_segment(local_origin, local_end)
		if hit is Vector3:
			var global_hit: Vector3 = node.to_global(hit)
			var length: float = origin.distance_to(global_hit)
			if length < nearest:
				nearest = length
				chosen = id
				point = global_hit
	return {"id": chosen, "position": point, "distance": nearest}

func pick(origin: Vector3, direction: Vector3, distance: float = 10.0) -> String:
	return str(pick_hit(origin, direction, distance)["id"])

func obstacles(excluded: String = "") -> Array:
	var result: Array = []
	for id: String in entities:
		var dims: Dictionary = entities[id].get("dimensions", {})
		if id != excluded and dims.get("entity.kind") in ["box", "image", "file", "link"] and dims.get("interaction.heldBy") == null:
			result.append(entities[id])
	return result

static func vec3(value: Variant) -> Vector3:
	if value is Array and value.size() == 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return Vector3.ZERO

static func quat(value: Variant) -> Quaternion:
	if value is Array and value.size() == 4:
		var q: Quaternion = Quaternion(float(value[0]), float(value[1]), float(value[2]), float(value[3]))
		if q.length_squared() > 0.00001:
			return q.normalized()
	return Quaternion.IDENTITY

static func array3(value: Vector3) -> Array:
	return [value.x, value.y, value.z]
