extends Node
## Procedural humanoid animation for the bundled runtime VRM loader.

const ARM_DOWN := 1.18
const ARM_SWING := 0.42
const LEG_SWING := 0.52
const KNEE_BEND := 0.65

var skeleton: Skeleton3D
var bones: Dictionary = {}
var rest_rotation: Dictionary = {}
var rest_position: Dictionary = {}
var secondary_bones: Array[int] = []
var secondary_rest: Dictionary = {}
var phase: float = 0.0
var speed: float = 0.0
var target_speed: float = 0.0
var crouch: float = 0.0
var time: float = 0.0

func setup(skeleton_node: Skeleton3D, mapping: Dictionary) -> void:
	skeleton = skeleton_node
	for key: String in mapping:
		var index: int = _find_bone(str(mapping[key]))
		if index < 0:
			continue
		bones[key] = index
		rest_rotation[key] = skeleton.get_bone_pose_rotation(index)
		rest_position[key] = skeleton.get_bone_pose_position(index)
	var humanoid_indices: Array = bones.values()
	for index: int in skeleton.get_bone_count():
		if humanoid_indices.has(index):
			continue
		var bone_name: String = skeleton.get_bone_name(index).to_lower()
		if bone_name.contains("tail") or bone_name.contains("hair") or bone_name.contains("skirt"):
			secondary_bones.append(index)
			secondary_rest[index] = skeleton.get_bone_pose_rotation(index)
	set_process(true)

func set_motion(horizontal_speed: float, crouch_amount: float) -> void:
	target_speed = clampf(horizontal_speed, 0.0, 8.0)
	crouch = clampf(crouch_amount, 0.0, 1.0)

func _find_bone(name: String) -> int:
	var index: int = skeleton.find_bone(name)
	if index >= 0:
		return index
	var lower: String = name.to_lower()
	for i in skeleton.get_bone_count():
		if skeleton.get_bone_name(i).to_lower() == lower:
			return i
	for i in skeleton.get_bone_count():
		var candidate: String = skeleton.get_bone_name(i).to_lower()
		if candidate.ends_with("_" + lower) or candidate.ends_with(":" + lower):
			return i
	return -1

func _process(delta: float) -> void:
	if skeleton == null:
		return
	time += delta
	speed = lerpf(speed, target_speed, 1.0 - exp(-7.0 * delta))
	var walk: float = clampf(speed / 1.5, 0.0, 1.0)
	phase += delta * (1.2 + speed * 2.6)
	var swing: float = sin(phase) * walk
	var bob: float = absf(sin(phase)) * 0.018 * walk
	var idle: float = sin(time * 1.25)
	var fold: float = crouch

	_rotate("hips", _axis(Vector3.UP, sin(phase) * 0.05 * walk))
	_move("hips", Vector3(0, bob - 0.3 * fold, 0))
	_rotate("spine", _axis(Vector3.RIGHT, 0.025 * idle + 0.1 * fold))
	_rotate("chest", _axis(Vector3.RIGHT, 0.018 * idle + 0.08 * fold))
	_rotate("neck", _axis(Vector3.RIGHT, -0.015 * idle))
	_rotate("head", _axis(Vector3.RIGHT, -0.035 * fold + 0.02 * idle) *
		_axis(Vector3.UP, sin(time * 0.7) * 0.04))

	_rotate("leftUpperArm", _axis(Vector3.BACK, ARM_DOWN) *
		_axis(Vector3.RIGHT, -swing * ARM_SWING))
	_rotate("rightUpperArm", _axis(Vector3.BACK, -ARM_DOWN) *
		_axis(Vector3.RIGHT, swing * ARM_SWING))
	_rotate("leftLowerArm", _axis(Vector3.RIGHT, -0.12 - maxf(0.0, -swing) * 0.25))
	_rotate("rightLowerArm", _axis(Vector3.RIGHT, -0.12 - maxf(0.0, swing) * 0.25))

	_rotate("leftUpperLeg", _axis(Vector3.RIGHT, swing * LEG_SWING + fold * 0.65))
	_rotate("rightUpperLeg", _axis(Vector3.RIGHT, -swing * LEG_SWING + fold * 0.65))
	_rotate("leftLowerLeg", _axis(Vector3.RIGHT, -maxf(0.0, -swing) * KNEE_BEND - fold * 1.1))
	_rotate("rightLowerLeg", _axis(Vector3.RIGHT, -maxf(0.0, swing) * KNEE_BEND - fold * 1.1))
	_rotate("leftFoot", _axis(Vector3.RIGHT, maxf(0.0, -swing) * 0.2 + fold * 0.35))
	_rotate("rightFoot", _axis(Vector3.RIGHT, maxf(0.0, swing) * 0.2 + fold * 0.35))

	for index: int in secondary_bones:
		var wave: float = sin(time * 1.8 + float(index) * 0.7) * (0.05 + speed * 0.025)
		var side_wave: float = sin(time * 1.2 + float(index) * 0.4) * (0.03 + speed * 0.015)
		skeleton.set_bone_pose_rotation(index, secondary_rest[index] *
			_axis(Vector3.RIGHT, wave) * _axis(Vector3.BACK, side_wave))

func _rotate(key: String, offset: Quaternion) -> void:
	if not bones.has(key):
		return
	var index: int = bones[key]
	skeleton.set_bone_pose_rotation(index, rest_rotation[key] * offset)

func _move(key: String, offset: Vector3) -> void:
	if not bones.has(key):
		return
	var index: int = bones[key]
	skeleton.set_bone_pose_position(index, rest_position[key] + offset)

static func _axis(axis: Vector3, angle: float) -> Quaternion:
	return Quaternion(axis, angle)
