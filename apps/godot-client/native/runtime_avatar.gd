extends RefCounted

const StaticExtension = preload("res://addons/runtime_vrm/static_extension.gd")
const MAX_BYTES := 64 * 1024 * 1024
const MAX_JSON_BYTES := 8 * 1024 * 1024
const MAX_NODES := 4096
const MAX_VERTICES := 1000000
const MAX_PIXELS := 32 * 1024 * 1024
const MAX_IMAGE_SIDE := 8192
const ARRAY_LIMITS := {
	"nodes": MAX_NODES, "meshes": 512, "accessors": 8192, "bufferViews": 8192,
	"buffers": 1, "images": 128, "textures": 128, "materials": 256,
	"skins": 128, "scenes": 32, "samplers": 128, "animations": 256,
}
static var _diagnostic := ""


static func diagnostic() -> String:
	return _diagnostic


static func _reject(reason: String) -> Dictionary:
	_diagnostic = reason
	return {}


static func load_vrm(path: String) -> Node3D:
	_diagnostic = ""
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		_reject("Cannot open avatar")
		return null
	var length := file.get_length()
	if length < 28 or length > MAX_BYTES:
		_reject("Avatar size outside 28 bytes..64 MiB")
		return null
	var bytes := file.get_buffer(length)
	file.close()
	var checked := _validate(bytes)
	if checked.is_empty():
		return null
	# Rebuild from validated JSON, dropping extras and unneeded animation metadata.
	# Never pass a downloaded path to ResourceLoader or give glTF a base directory.
	var safe_bytes := _pack_glb(checked["json"], checked["bin"])
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	state.handle_binary_image = GLTFState.HANDLE_BINARY_EMBED_AS_UNCOMPRESSED
	var extension := StaticExtension.new()
	GLTFDocument.register_gltf_document_extension(extension, true)
	var error := document.append_from_buffer(safe_bytes, "", state)
	var scene: Node = null
	if error == OK:
		scene = document.generate_scene(state)
	GLTFDocument.unregister_gltf_document_extension(extension)
	if not scene is Node3D:
		if scene != null:
			scene.free()
		_reject("glTF runtime import failed: %s" % error)
		return null
	scene.name = "RuntimeAvatar"
	scene.set_meta("vrm_static", true)
	return scene as Node3D


static func _pack_glb(json: Dictionary, binary: PackedByteArray) -> PackedByteArray:
	var text := JSON.stringify(json).to_utf8_buffer()
	while text.size() % 4:
		text.append(32)
	var body := binary.duplicate()
	while body.size() % 4:
		body.append(0)
	var result := PackedByteArray()
	result.resize(12)
	result.encode_u32(0, 0x46546c67)
	result.encode_u32(4, 2)
	result.encode_u32(8, 28 + text.size() + body.size())
	var header := PackedByteArray()
	header.resize(8)
	header.encode_u32(0, text.size())
	header.encode_u32(4, 0x4e4f534a)
	result.append_array(header)
	result.append_array(text)
	header.encode_u32(0, body.size())
	header.encode_u32(4, 0x004e4942)
	result.append_array(header)
	result.append_array(body)
	return result


static func _validate(bytes: PackedByteArray) -> Dictionary:
	if bytes.size() < 28 or bytes.size() > MAX_BYTES:
		return _reject("Invalid GLB size")
	if bytes.decode_u32(0) != 0x46546c67 or bytes.decode_u32(4) != 2 or bytes.decode_u32(8) != bytes.size():
		return _reject("Invalid GLB 2 header")
	var json_length := bytes.decode_u32(12)
	if bytes.decode_u32(16) != 0x4e4f534a or json_length > MAX_JSON_BYTES or json_length % 4 or json_length + 28 > bytes.size():
		return _reject("Invalid GLB JSON chunk")
	var bin_offset := 20 + json_length
	var bin_length := bytes.decode_u32(bin_offset)
	if bytes.decode_u32(bin_offset + 4) != 0x004e4942 or bin_length % 4 or bin_offset + 8 + bin_length != bytes.size():
		return _reject("Expected one embedded GLB binary chunk")
	var text := bytes.slice(20, bin_offset)
	# Bound nesting before the JSON parser or recursive sanitizer sees untrusted data.
	var depth := 0
	var quoted := false
	var escaped := false
	for byte in text:
		if quoted:
			if escaped:
				escaped = false
			elif byte == 92:
				escaped = true
			elif byte == 34:
				quoted = false
		elif byte == 34:
			quoted = true
		elif byte == 123 or byte == 91:
			depth += 1
			if depth > 48:
				return _reject("JSON nesting limit exceeded")
		elif byte == 125 or byte == 93:
			depth -= 1
	var parser := JSON.new()
	if parser.parse(text.get_string_from_utf8()) != OK or not parser.data is Dictionary:
		return _reject("Invalid glTF JSON")
	var json: Dictionary = parser.data
	if not _safe_tree(json):
		return _reject("External URI, unsupported extension, or unsafe JSON value")
	if not json.get("asset") is Dictionary or json["asset"].get("version") != "2.0":
		return _reject("Expected glTF 2.0")
	var extensions: Dictionary = json.get("extensions", {})
	if not extensions.get("VRM") is Dictionary or not str(extensions["VRM"].get("specVersion", "")).begins_with("0."):
		return _reject("Only VRM 0.x is supported")
	for key in ARRAY_LIMITS:
		if not json.get(key, []) is Array or json.get(key, []).size() > ARRAY_LIMITS[key]:
			return _reject("Descriptor count/type limit: " + key)
		for item in json.get(key, []):
			if not item is Dictionary:
				return _reject("Invalid descriptor: " + key)
	var buffers: Array = json.get("buffers", [])
	if buffers.size() != 1 or not _integer(buffers[0].get("byteLength"), 0, bin_length) or bin_length - int(buffers[0]["byteLength"]) > 3:
		return _reject("Invalid embedded buffer")
	var binary := bytes.slice(bin_offset + 8)
	var views: Array = json.get("bufferViews", [])
	for view in views:
		if view.get("buffer", -1) != 0 or not _integer(view.get("byteOffset", 0), 0, bin_length) or not _integer(view.get("byteLength"), 0, bin_length):
			return _reject("Invalid bufferView")
		if int(view.get("byteOffset", 0)) + int(view["byteLength"]) > int(buffers[0]["byteLength"]):
			return _reject("bufferView exceeds buffer")
		if view.has("byteStride") and not _integer(view["byteStride"], 4, 252):
			return _reject("Invalid bufferView stride")
	var accessors: Array = json.get("accessors", [])
	var components := {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
	var widths := {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
	var total_values := 0
	for accessor in accessors:
		if not _index(accessor.get("bufferView"), views.size()) or accessor.has("sparse") or not _integer(accessor.get("count"), 1, MAX_VERTICES * 3):
			return _reject("Invalid or unsupported sparse accessor")
		if not _integer(accessor.get("componentType"), 5120, 5126) or not components.has(int(accessor["componentType"])) or not widths.has(accessor.get("type", "")):
			return _reject("Invalid accessor format")
		var view: Dictionary = views[int(accessor["bufferView"])]
		var element_size: int = components[int(accessor["componentType"])] * widths[accessor["type"]]
		var stride = view.get("byteStride", element_size)
		var offset = accessor.get("byteOffset", 0)
		if not _integer(stride, element_size, 252) or not _integer(offset, 0, bin_length) or int(offset) + (int(accessor["count"]) - 1) * int(stride) + element_size > int(view["byteLength"]):
			return _reject("Accessor exceeds bufferView")
		total_values += int(accessor["count"]) * widths[accessor["type"]]
		if total_values > MAX_VERTICES * 32:
			return _reject("Accessor allocation budget exceeded")
	if not _validate_geometry(json, binary):
		return _reject("Invalid or excessive scene geometry")
	var pixels := 0
	for image in json.get("images", []):
		if not _index(image.get("bufferView"), views.size()) or not image.get("mimeType", "") in ["image/png", "image/jpeg"]:
			return _reject("Only embedded PNG/JPEG images supported")
		var view: Dictionary = views[int(image["bufferView"])]
		var start := int(view.get("byteOffset", 0))
		var dimensions := _image_dimensions(binary.slice(start, start + int(view["byteLength"])), image["mimeType"])
		if dimensions.x < 1 or dimensions.y < 1 or dimensions.x > MAX_IMAGE_SIDE or dimensions.y > MAX_IMAGE_SIDE:
			return _reject("Invalid or oversized image dimensions")
		pixels += dimensions.x * dimensions.y
		if pixels > MAX_PIXELS:
			return _reject("Decoded image budget exceeded")
	for texture in json.get("textures", []):
		if not _index(texture.get("source"), json.get("images", []).size()):
			return _reject("Invalid texture image")
	if not _validate_materials(json):
		return _reject("Invalid VRM material properties")
	json.erase("animations")
	# Static import has no use for metadata, spring bones, or blend-shape bindings.
	json["extensions"]["VRM"] = {"specVersion": extensions["VRM"]["specVersion"], "materialProperties": extensions["VRM"].get("materialProperties", [])}
	return {"json": json, "bin": binary}


static func _integer(value: Variant, minimum: int, maximum: int) -> bool:
	return (value is float or value is int) and is_finite(float(value)) and float(value) == floor(float(value)) and value >= minimum and value <= maximum


static func _index(value: Variant, count: int) -> bool:
	return _integer(value, 0, count - 1)


static func _safe_tree(value: Variant) -> bool:
	if value is Dictionary:
		value.erase("extras")
		for key in value:
			if key.to_lower() in ["uri", "script", "scripts"]:
				return false
			if key == "extensions":
				if not value[key] is Dictionary:
					return false
				for extension in value[key]:
					if not extension in ["VRM", "KHR_materials_unlit", "KHR_texture_transform"]:
						return false
			if key in ["extensionsUsed", "extensionsRequired"]:
				if not value[key] is Array:
					return false
				for extension in value[key]:
					if not extension in ["VRM", "KHR_materials_unlit", "KHR_texture_transform"]:
						return false
			if not _safe_tree(value[key]):
				return false
	elif value is Array:
		if value.size() > MAX_VERTICES:
			return false
		for item in value:
			if not _safe_tree(item):
				return false
	elif value is float and (not is_finite(value) or absf(value) > 1.0e12):
		return false
	return true


static func _validate_geometry(json: Dictionary, binary: PackedByteArray) -> bool:
	var nodes: Array = json.get("nodes", [])
	var meshes: Array = json.get("meshes", [])
	var accessors: Array = json.get("accessors", [])
	var mesh_vertices: Array[int] = []
	var primitives := 0
	var decoded_vertices := 0
	var decoded_indices := 0
	for mesh in meshes:
		if not mesh.get("primitives") is Array:
			return false
		var vertices := 0
		for primitive in mesh["primitives"]:
			primitives += 1
			if primitives > 2048 or not primitive is Dictionary or not primitive.get("attributes") is Dictionary:
				return false
			if not _index(primitive["attributes"].get("POSITION"), accessors.size()):
				return false
			var position: Dictionary = accessors[int(primitive["attributes"]["POSITION"])]
			if position["type"] != "VEC3" or position["componentType"] != 5126:
				return false
			vertices += int(position["count"])
			if not primitive.get("targets", []) is Array or primitive.get("targets", []).size() > 64:
				return false
			decoded_vertices += int(accessors[int(primitive["attributes"]["POSITION"])]["count"]) * (1 + primitive.get("targets", []).size())
			if decoded_vertices > MAX_VERTICES * 4:
				return false
			for attributes in [primitive["attributes"]] + primitive.get("targets", []):
				if not attributes is Dictionary:
					return false
				for accessor in attributes.values():
					if not _index(accessor, accessors.size()):
						return false
			if primitive.has("indices") and not _index(primitive["indices"], accessors.size()):
				return false
			if primitive.has("indices"):
				var indices: Dictionary = accessors[int(primitive["indices"])]
				if indices["type"] != "SCALAR" or not int(indices["componentType"]) in [5121, 5123, 5125]:
					return false
				decoded_indices += int(indices["count"])
				if decoded_indices > MAX_VERTICES * 6:
					return false
				var view: Dictionary = json["bufferViews"][int(indices["bufferView"])]
				var width := 1 if indices["componentType"] == 5121 else (2 if indices["componentType"] == 5123 else 4)
				var stride := int(view.get("byteStride", width))
				var start := int(view.get("byteOffset", 0)) + int(indices.get("byteOffset", 0))
				for index in range(int(indices["count"])):
					var offset := start + index * stride
					var vertex := int(binary[offset]) if width == 1 else (binary.decode_u16(offset) if width == 2 else binary.decode_u32(offset))
					if vertex >= int(position["count"]):
						return false
			if primitive.has("material") and not _index(primitive["material"], json.get("materials", []).size()):
				return false
		mesh_vertices.append(vertices)
	var parents: Array[int] = []
	parents.resize(nodes.size())
	parents.fill(-1)
	var total_vertices := 0
	for i in range(nodes.size()):
		var node: Dictionary = nodes[i]
		for key in {"translation": 3, "rotation": 4, "scale": 3, "matrix": 16}:
			if node.has(key):
				if not node[key] is Array or node[key].size() != {"translation": 3, "rotation": 4, "scale": 3, "matrix": 16}[key]:
					return false
				for number in node[key]:
					if not (number is float or number is int):
						return false
		if node.has("skin") and not _index(node["skin"], json.get("skins", []).size()):
			return false
		if node.has("mesh"):
			if not _index(node["mesh"], meshes.size()):
				return false
			total_vertices += mesh_vertices[int(node["mesh"])]
		if total_vertices > MAX_VERTICES or not node.get("children", []) is Array:
			return false
		for child in node.get("children", []):
			if not _index(child, nodes.size()) or parents[int(child)] != -1:
				return false
			parents[int(child)] = i
	for i in range(nodes.size()):
		var current := i
		var depth := 0
		while current != -1:
			depth += 1
			if depth > 128:
				return false
			current = parents[current]
	for skin in json.get("skins", []):
		if not skin.get("joints") is Array or skin["joints"].size() > 256:
			return false
		for joint in skin["joints"]:
			if not _index(joint, nodes.size()):
				return false
		if skin.has("inverseBindMatrices") and not _index(skin["inverseBindMatrices"], accessors.size()):
			return false
	for scene in json.get("scenes", []):
		if not scene.get("nodes", []) is Array:
			return false
		for node in scene.get("nodes", []):
			if not _index(node, nodes.size()) or parents[int(node)] != -1:
				return false
	return true


static func _validate_materials(json: Dictionary) -> bool:
	var properties = json["extensions"]["VRM"].get("materialProperties", [])
	if not properties is Array or properties.size() != json.get("materials", []).size():
		return false
	for material in properties:
		if not material is Dictionary or not material.get("shader", "") in ["VRM/MToon", "VRM_USE_GLTFSHADER", "VRM/UnlitTransparentZWrite", "VRM/UnlitTransparent", "VRM/UnlitTexture", "VRM/UnlitCutout", "Standard", "UniGLTF/UniUnlit"]:
			return false
		if not _integer(material.get("renderQueue", 3000), -1, 10000):
			return false
		for key in ["floatProperties", "vectorProperties", "textureProperties"]:
			if not material.get(key, {}) is Dictionary:
				return false
			material[key] = material.get(key, {})
		for value in material["floatProperties"].values():
			if not (value is float or value is int):
				return false
		for value in material["vectorProperties"].values():
			if not value is Array or value.size() != 4:
				return false
			for number in value:
				if not (number is float or number is int):
					return false
		for value in material["textureProperties"].values():
			if not _index(value, json.get("textures", []).size()):
				return false
	return true


static func _image_dimensions(data: PackedByteArray, mime: String) -> Vector2i:
	if mime == "image/png":
		if data.size() < 33 or data.slice(0, 8) != PackedByteArray([137, 80, 78, 71, 13, 10, 26, 10]) or data.slice(12, 16).get_string_from_ascii() != "IHDR":
			return Vector2i.ZERO
		return Vector2i(_big_u32(data, 16), _big_u32(data, 20))
	if data.size() < 4 or data[0] != 255 or data[1] != 216:
		return Vector2i.ZERO
	var offset := 2
	while offset + 4 <= data.size():
		if data[offset] != 255:
			return Vector2i.ZERO
		var marker := int(data[offset + 1])
		if marker == 255:
			offset += 1
			continue
		var length := int(data[offset + 2]) * 256 + int(data[offset + 3])
		if length < 2 or offset + 2 + length > data.size():
			return Vector2i.ZERO
		if marker in [192, 193, 194]:
			if length < 8:
				return Vector2i.ZERO
			return Vector2i(int(data[offset + 7]) * 256 + int(data[offset + 8]), int(data[offset + 5]) * 256 + int(data[offset + 6]))
		offset += 2 + length
	return Vector2i.ZERO


static func _big_u32(data: PackedByteArray, offset: int) -> int:
	return (int(data[offset]) << 24) | (int(data[offset + 1]) << 16) | (int(data[offset + 2]) << 8) | int(data[offset + 3])
