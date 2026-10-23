extends SceneTree
## Requires a local space server and Kubo. Exercises native actors and real display nodes.

const WorldProjection = preload("res://scripts/world_projection.gd")
var clients: Array[RefCounted] = []
var projections: Array[Node3D] = []
var states: Array[Dictionary] = [{}, {}]
var assets: Dictionary = {}
var requested: Dictionary = {}
var failures: Array[String] = []
var server: String = "ws://127.0.0.1:18080/ws"
var avatar: String = ""
var directory: String


func _initialize() -> void:
	for argument: String in OS.get_cmdline_user_args():
		if argument.begins_with("--server="):
			server = argument.trim_prefix("--server=")
		elif argument.begins_with("--avatar="):
			avatar = argument.trim_prefix("--avatar=")
	directory = OS.get_environment("TMPDIR").path_join("proto-godot-content-%s" % OS.get_process_id())
	if not directory.is_absolute_path():
		directory = "/tmp/kilo/proto-godot-content-%s" % OS.get_process_id()
	DirAccess.make_dir_recursive_absolute(directory)
	call_deferred("run")


func run() -> void:
	if not ClassDB.class_exists("ProtoClient"):
		push_error("Native extension is required")
		quit(1)
		return
	var png_path: String = directory.path_join("shared.png")
	var image: Image = Image.create(32, 24, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.2, 0.6, 0.8))
	image.save_png(png_path)
	var file_path: String = directory.path_join("multi-block.bin")
	var file: FileAccess = FileAccess.open(file_path, FileAccess.WRITE)
	var bytes: PackedByteArray = PackedByteArray()
	bytes.resize(2 * 1024 * 1024 + 713)
	for index: int in bytes.size():
		bytes[index] = (index * 31 + (index >> 10)) % 256
	file.store_buffer(bytes)
	file.close()
	for index: int in 2:
		var client: RefCounted = ClassDB.instantiate("ProtoClient")
		client.configure(directory.path_join("client-%s" % index))
		clients.append(client)
		var projection: Node3D = WorldProjection.new()
		root.add_child(projection)
		projection.image_decoder = client
		projections.append(projection)
		projection.asset_requested.connect(func(cid: String) -> void: client.command({"op": "fetch", "cid": cid}))
		client.command({"op": "connect", "server": server, "name": "content-%s" % index})
	if not await wait_for(func() -> bool: return states[0].get("ipfsReady", false) and states[1].get("ipfsReady", false), 20.0):
		finish("clients did not become IPFS-ready")
		return
	clients[0].command({"op": "drop", "path": png_path, "position": [4, 0, -4], "yaw": 0})
	clients[0].command({"op": "drop", "path": file_path, "position": [6, 0, -4], "yaw": 0})
	if not avatar.is_empty():
		clients[0].command({"op": "avatar", "path": avatar})
	var completed: bool = await wait_for(func() -> bool:
		return asset_for_name("shared.png") != "" and asset_for_name("multi-block.bin") != "" and (avatar.is_empty() or avatar_loaded()), 60.0)
	if not completed:
		finish("content did not reach observer assets/display nodes before timeout")
		return
	for name: String in ["shared.png", "multi-block.bin"]:
		var source: String = png_path if name == "shared.png" else file_path
		var downloaded: String = asset_for_name(name)
		if FileAccess.get_sha256(source) != FileAccess.get_sha256(downloaded):
			failures.append("content digest differs: " + name)
	var png_entity: String = entity_for_name("shared.png")
	var panel: MeshInstance3D = projections[1].views[png_entity].get_child(0)
	if not panel.material_override is StandardMaterial3D or panel.material_override.albedo_texture == null:
		failures.append("observer image node has no decoded texture")
	finish("")


func wait_for(condition: Callable, timeout: float) -> bool:
	var deadline: int = Time.get_ticks_msec() + int(timeout * 1000)
	while Time.get_ticks_msec() < deadline:
		pump()
		if condition.call():
			return true
		await create_timer(0.025).timeout
	return false


func pump() -> void:
	for index: int in clients.size():
		for event: Dictionary in clients[index].poll_events():
			match event.get("type", ""):
				"state":
					states[index] = event
					projections[index].apply_snapshot(event.get("entities", []), str(event.get("selfId", "")))
					if index == 1:
						for entity: Dictionary in event.get("entities", []):
							var dims: Dictionary = entity.get("dimensions", {})
							var cid: String = str(dims.get("content.cid", ""))
							if dims.get("entity.kind") == "file" and not cid.is_empty() and not requested.has(cid):
								requested[cid] = true
								clients[index].command({"op": "fetch", "cid": cid})
				"asset":
					projections[index].asset_ready(str(event.cid), str(event.path))
					if index == 1:
						assets[str(event.cid)] = str(event.path)
				"error":
					print("CONTENT_ERROR " + JSON.stringify(event))


func entity_for_name(name: String) -> String:
	for id: String in projections[1].entities:
		if projections[1].entities[id].get("dimensions", {}).get("content.name") == name:
			return id
	return ""


func asset_for_name(name: String) -> String:
	var id: String = entity_for_name(name)
	if id.is_empty() or not projections[1].views.has(id):
		return ""
	var cid: String = str(projections[1].entities[id].dimensions.get("content.cid", ""))
	return str(assets.get(cid, ""))


func avatar_loaded() -> bool:
	for id: String in projections[1].entities:
		var dims: Dictionary = projections[1].entities[id].get("dimensions", {})
		if dims.get("entity.kind") == "peer" and dims.get("peer.name") == "content-0":
			return projections[1].views.has(id) and projections[1].views[id].has_node("Avatar")
	return false


func finish(error: String) -> void:
	if not error.is_empty():
		failures.append(error)
	for client: RefCounted in clients:
		client.command({"op": "disconnect"})
	for failure: String in failures:
		push_error(failure)
	print("PROTO_TEST content_roundtrip failures=%s assets=%s avatar=%s data=%s" % [failures.size(), assets.size(), not avatar.is_empty(), directory])
	quit(0 if failures.is_empty() else 1)
