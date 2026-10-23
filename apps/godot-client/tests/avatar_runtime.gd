extends SceneTree

const Avatar = preload("res://native/runtime_avatar.gd")
var failures := 0
var checks := 0


func _initialize() -> void:
	call_deferred("_run")


func _check(condition: bool, label: String) -> void:
	checks += 1
	if not condition:
		failures += 1
		push_error("AVATAR_TEST failed: " + label + " / " + Avatar.diagnostic())


func _fixture() -> Dictionary:
	# Original synthetic triangle, no third-party model or redistribution terms.
	return {
		"asset": {"version": "2.0"}, "extensionsUsed": ["VRM"],
		"extensions": {"VRM": {"specVersion": "0.0", "materialProperties": [{
			"name": "FixtureMToon", "shader": "VRM/MToon", "renderQueue": 2000,
			"floatProperties": {"_CullMode": 0, "_BlendMode": 0},
			"vectorProperties": {"_Color": [0.3, 0.6, 0.9, 1.0]}, "textureProperties": {},
		}]}},
		"buffers": [{"byteLength": 36}],
		"bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}],
		"accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [-0.5, 0.0, 0.0], "max": [0.5, 1.0, 0.0]}],
		"materials": [{"name": "FixtureMToon", "pbrMetallicRoughness": {"baseColorFactor": [0.3, 0.6, 0.9, 1.0]}}],
		"meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "material": 0}]}],
		"nodes": [{"mesh": 0, "name": "FixtureTriangle"}], "scenes": [{"nodes": [0]}], "scene": 0,
	}


func _binary() -> PackedByteArray:
	return PackedFloat32Array([-0.5, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, 1.0, 0.0]).to_byte_array()


func _rejected(json: Dictionary, label: String) -> void:
	_check(Avatar._validate(Avatar._pack_glb(json, _binary())).is_empty(), label)
	_check(not Avatar.diagnostic().is_empty(), label + " diagnostic")


func _run() -> void:
	_check(not Avatar._validate(Avatar._pack_glb(_fixture(), _binary())).is_empty(), "valid fixture preflight")
	for uri in ["../../secret.bin", "file:///etc/passwd", "https://example.com/a.bin", "data:application/octet-stream;base64,AA==", "res://native/unsafe.gd"]:
		var json := _fixture()
		json["buffers"][0]["uri"] = uri
		_rejected(json, "reject buffer URI " + uri)
	var json := _fixture()
	json["images"] = [{"uri": "../../secret.png"}]
	_rejected(json, "reject external image")
	json = _fixture()
	json["extensions"]["VRM"]["specVersion"] = "1.0"
	_rejected(json, "reject VRM1")
	json = _fixture()
	json["extensions"]["GODOT_single_root"] = {}
	_rejected(json, "reject engine extension")
	json = _fixture()
	json["nodes"][0]["children"] = [0]
	_rejected(json, "reject cyclic node")
	json = _fixture()
	json["nodes"] = []
	for i in range(Avatar.MAX_NODES + 1):
		json["nodes"].append({})
	_rejected(json, "reject node budget")
	json = _fixture()
	json["accessors"][0]["count"] = Avatar.MAX_VERTICES * 4
	_rejected(json, "reject vertex budget")
	json = _fixture()
	json["bufferViews"][0]["byteLength"] = 4000
	_rejected(json, "reject out of bounds bufferView")
	json = _fixture()
	json["accessors"][0]["byteOffset"] = 4
	_rejected(json, "reject out of bounds accessor")
	json = _fixture()
	json["bufferViews"].append({"buffer": 0, "byteOffset": 0, "byteLength": 3})
	json["accessors"].append({"bufferView": 1, "componentType": 5121, "count": 3, "type": "SCALAR"})
	json["meshes"][0]["primitives"][0]["indices"] = 1
	var index_binary := _binary()
	index_binary[0] = 255
	_check(Avatar._validate(Avatar._pack_glb(json, index_binary)).is_empty(), "reject indices exceeding vertex count")
	json = _fixture()
	json["bufferViews"].append({"buffer": 0, "byteOffset": 0, "byteLength": 3})
	json["accessors"].append({"bufferView": 1, "componentType": 5121, "count": 3, "type": "SCALAR"})
	json["meshes"][0]["primitives"][0]["indices"] = 1
	index_binary = _binary()
	index_binary[0] = 0
	index_binary[1] = 1
	index_binary[2] = 2
	_check(not Avatar._validate(Avatar._pack_glb(json, index_binary)).is_empty(), "accept JSON numeric index component type")
	json = _fixture()
	json["extensions"]["VRM"]["materialProperties"][0]["textureProperties"] = {"_MainTex": 2}
	_rejected(json, "reject bad MToon texture index")
	var oversized_png := PackedByteArray([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 1, 0, 0, 0, 1, 0, 0, 8, 6, 0, 0, 0, 0, 0, 0, 0])
	json = _fixture()
	json["buffers"][0]["byteLength"] = 72
	json["bufferViews"].append({"buffer": 0, "byteOffset": 36, "byteLength": 33})
	json["images"] = [{"bufferView": 1, "mimeType": "image/png"}]
	var image_binary := _binary()
	image_binary.append_array(oversized_png)
	image_binary.resize(72)
	_check(Avatar._validate(Avatar._pack_glb(json, image_binary)).is_empty(), "reject image decompression bomb dimensions")
	var malformed := Avatar._pack_glb(_fixture(), _binary())
	malformed.encode_u32(8, malformed.size() + 1)
	_check(Avatar._validate(malformed).is_empty(), "reject GLB length mismatch")
	json = _fixture()
	json["nodes"][0]["extras"] = {"script": "res://unsafe.gd", "uri": "https://example.com/"}
	var sanitized := Avatar._validate(Avatar._pack_glb(json, _binary()))
	_check(not sanitized.is_empty() and not sanitized["json"]["nodes"][0].has("extras"), "strip extras before engine")
	var path := "user://avatar-runtime-fixture.vrm"
	var file := FileAccess.open(path, FileAccess.WRITE)
	file.store_buffer(Avatar._pack_glb(_fixture(), _binary()))
	file.close()
	var avatar := Avatar.load_vrm(path)
	_check(avatar != null, "runtime GLTFDocument import without editor plugin")
	if avatar != null:
		root.add_child(avatar)
		var meshes := avatar.find_children("*", "MeshInstance3D", true, false)
		_check(meshes.size() == 1, "actual runtime mesh node")
		if meshes.size() == 1:
			_check(meshes[0].mesh.surface_get_material(0) is ShaderMaterial, "actual vendor MToon material")
		_check(avatar.get_meta("vrm_static", false), "static runtime avatar marker")
		avatar.free()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--avatar="):
			var actual := Avatar.load_vrm(argument.trim_prefix("--avatar="))
			_check(actual != null, "local real-world VRM asset")
			if actual != null:
				_check(actual.find_children("*", "MeshInstance3D", true, false).size() > 0, "real-world avatar has geometry")
				actual.free()
	print("AVATAR_TEST " + JSON.stringify({"checks": checks, "failures": failures}))
	quit(0 if failures == 0 else 1)
