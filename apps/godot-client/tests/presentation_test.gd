extends SceneTree
## Scene-level adapter tests. Network E2E must additionally run the real native session.

const WorldProjection = preload("res://scripts/world_projection.gd")
const Mirror = preload("res://scripts/mirror.gd")

var failures: int = 0
var events: Array[Dictionary] = []

func _initialize() -> void:
	_run.call_deferred()

func _check(condition: bool, message: String) -> void:
	if not condition:
		failures += 1
		push_error(message)

func _run() -> void:
	var world: Node3D = load("res://scenes/world.tscn").instantiate()
	root.add_child(world)
	var adapter: WorldProjection = world.get_node("Entities")
	adapter.image_decoder = ClassDB.instantiate("ProtoClient")
	adapter.observed.connect(func(event: Dictionary) -> void: events.append(event))
	var box: Dictionary = {"id": "box-test", "version": 1, "dimensions": {"entity.kind": "box", "space.position": [0, 0, -2], "space.scale": 1, "box.size": 1, "custom.retained": {"unknown": [1, 2, 3]}}}
	var peer: Dictionary = {"id": "self", "version": 1, "dimensions": {"entity.kind": "peer", "peer.name": "Test", "space.position": [0, 0, 0]}}
	var unknown: Dictionary = {"id": "unknown", "version": 1, "dimensions": {"entity.kind": "future-kind", "future.data": "kept"}}
	adapter.apply_snapshot([box, peer, unknown], "self")
	_check(adapter.entities.size() == 3, "Generic Reader cache must retain unmapped entities")
	_check(adapter.entities["box-test"]["dimensions"]["custom.retained"]["unknown"] == [1, 2, 3], "Unknown dimensions must survive projection")
	_check(adapter.views.size() == 2, "Unknown kinds must not invent a display mapping")
	_check(adapter.views["box-test"].position == Vector3(0, 0, -2), "Reader position must reach actual Node")
	_check(adapter.pick(Vector3(0, 0.5, 0), Vector3.FORWARD) == "box-test", "Picking must use bottom-anchored world dimensions")
	_check(adapter.obstacles().size() == 1 and adapter.obstacles()[0]["id"] == "box-test", "Collision bridge must receive raw SpaceEntity values")
	var body: VisualInstance3D = adapter.views["self"].get_child(0)
	_check(body.layers == 2, "Own avatar must exist only on mirror visibility layer")
	_check(events[0]["event"] == "node_created" and not str(events[0]["nodePath"]).is_empty(), "Observation must evidence an actual scene node")
	adapter.views["box-test"].position = Vector3(8, 8, 8)
	adapter.restore("box-test")
	_check(adapter.views["box-test"].position == Vector3(0, 0, -2), "Rejected optimistic carry must restore Reader pose")
	box = box.duplicate(true)
	box["version"] = 2
	box["dimensions"]["space.position"] = [2, 0, -2]
	adapter.apply_snapshot([box, peer, unknown], "self")
	_check(adapter.views["box-test"].position == Vector3(2, 0, -2), "Reader update must change same display Node")
	_check(events[-1]["event"] == "node_updated", "Reader update must emit node_updated")
	adapter.apply_snapshot([peer], "self")
	_check(not adapter.views.has("box-test") and adapter.entities.size() == 1, "Snapshot replacement must remove stale display and dimensions")
	_check(events[-1]["event"] == "node_removed", "Reader remove must emit node_removed")
	peer = peer.duplicate(true)
	peer["version"] = 2
	peer["dimensions"]["peer.avatarCid"] = "invalid-avatar-fixture"
	adapter.apply_snapshot([peer], "self")
	adapter.asset_ready("invalid-avatar-fixture", "res://project.godot")
	_check(adapter.views["self"].get_child_count() > 1, "Rejected avatar must preserve the static fallback skeleton")
	body = adapter.views["self"].get_child(0)
	_check(body.layers == 2, "Replacing an avatar must preserve mirror-only self layers")
	var raster: Image = Image.create(4, 4, false, Image.FORMAT_RGBA8)
	raster.fill(Color.CORAL)
	var raster_path: String = "user://presentation-image-cid"
	var raster_file: FileAccess = FileAccess.open(raster_path, FileAccess.WRITE)
	raster_file.store_buffer(raster.save_png_to_buffer())
	raster_file.close()
	var decoded: Image = adapter._decode_image(raster_path)
	_check(decoded != null and decoded.get_width() == 4, "CID image paths without extensions must decode by raster magic")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(raster_path))
	var mirror: Mirror = Mirror.new()
	world.add_child(mirror)
	mirror.source = world.get_node("Player/Camera")
	mirror.set_enabled(true)
	var fixed: Vector3 = mirror.global_position
	mirror.source.position.x += 1
	mirror._process(0)
	_check(mirror.global_position == fixed, "Mirror plane must remain fixed when player moves")
	_check(mirror.camera.cull_mask == 3 and mirror.surface.layers == 4, "Mirror camera must include own avatar and exclude mirror recursion")
	_check(mirror.camera.global_position.z < fixed.z, "Mirror camera must reflect across the actual plane")
	adapter.clear()
	_check(adapter.entities.is_empty() and adapter.views.is_empty(), "Disconnect must discard previous session mapping")
	world.queue_free()
	await process_frame
	print("PROTO_EVENT " + JSON.stringify({"event": "presentation_tests", "failures": failures}))
	quit(0 if failures == 0 else 1)
