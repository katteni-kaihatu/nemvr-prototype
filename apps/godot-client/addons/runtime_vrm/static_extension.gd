extends "res://addons/vrm/vrm_extension.gd"

# Use the pinned importer's materials, not its animation/retarget/editor pipeline.
func _import_preflight(_state: GLTFState, _extensions: PackedStringArray = PackedStringArray(), _unused: Variant = null) -> Error:
	return OK


func _import_post_parse(_state: GLTFState) -> Error:
	return OK


func _import_post(state: GLTFState, node: Node) -> Error:
	_update_materials(state.json["extensions"]["VRM"], state)
	# VRM 0.x faces +Z; the client uses -Z forward.
	(node as Node3D).rotate_y(PI)
	return OK
