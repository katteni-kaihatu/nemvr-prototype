extends SceneTree

var packer := PCKPacker.new()
var failed := false


func _initialize() -> void:
	var arguments := OS.get_cmdline_user_args()
	if arguments.size() != 1 or not arguments[0].is_absolute_path():
		push_error("Usage: --script res://tests/avatar_pack.gd -- /absolute/fixture.pck")
		quit(1)
		return
	if packer.pck_start(arguments[0]) != OK:
		quit(1)
		return
	_add("res://project.godot")
	_add("res://native/runtime_avatar.gd")
	_add("res://tests/avatar_runtime.gd")
	_add("res://.godot/global_script_class_cache.cfg")
	_folder("res://addons")
	if packer.flush() != OK:
		failed = true
	print("AVATAR_PACK " + JSON.stringify({"path": arguments[0], "failed": failed}))
	quit(1 if failed else 0)


func _add(path: String) -> void:
	if packer.add_file(path, ProjectSettings.globalize_path(path)) != OK:
		failed = true


func _folder(path: String) -> void:
	var directory := DirAccess.open(path)
	if directory == null:
		failed = true
		return
	for file in directory.get_files():
		if not file.begins_with("."):
			_add(path.path_join(file))
	for folder in directory.get_directories():
		if not folder.begins_with("."):
			_folder(path.path_join(folder))
