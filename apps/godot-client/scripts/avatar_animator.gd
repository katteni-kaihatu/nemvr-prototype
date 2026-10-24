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
var hand_targets: Dictionary = {}
var hand_tracked: Dictionary = {}
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

func set_hand_targets(left: Vector3, right: Vector3, left_tracked: bool, right_tracked: bool) -> void:
	hand_targets["left"] = left
	hand_targets["right"] = right
	hand_tracked["left"] = left_tracked
	hand_tracked["right"] = right_tracked

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

	_apply_hand_ik()
	skeleton.force_update_all_bone_transforms()

func _apply_hand_ik() -> void:
	if hand_targets.is_empty():
		return
	skeleton.force_update_all_bone_transforms()
	var inverse: Transform3D = skeleton.global_transform.affine_inverse()
	for side: String in ["left", "right"]:
		var upper_key: String = side + "UpperArm"
		var lower_key: String = side + "LowerArm"
		if not bones.has(upper_key) or not bones.has(lower_key):
			continue
		var upper: int = bones[upper_key]
		var lower: int = bones[lower_key]
		if not bool(hand_tracked.get(side, false)):
			skeleton.set_bone_global_pose_override(upper, Transform3D(), 0.0, false)
			skeleton.set_bone_global_pose_override(lower, Transform3D(), 0.0, false)
			continue
		var target: Vector3 = inverse * (hand_targets[side] as Vector3)
		var upper_pose: Transform3D = skeleton.get_bone_global_pose(upper)
		var lower_pose: Transform3D = skeleton.get_bone_global_pose(lower)
		var upper_length: float = upper_pose.origin.distance_to(lower_pose.origin)
		var hand_key: String = side + "Hand"
		var lower_length: float = lower_pose.origin.distance_to(
			skeleton.get_bone_global_pose(bones[hand_key]).origin) if bones.has(hand_key) else 0.25
		var to_target: Vector3 = target - upper_pose.origin
		var raw_distance: float = to_target.length()
		if raw_distance < 0.35:
			skeleton.set_bone_global_pose_override(upper, Transform3D(), 0.0, false)
			skeleton.set_bone_global_pose_override(lower, Transform3D(), 0.0, false)
			continue
		var distance: float = clampf(raw_distance, 0.05, maxf(upper_length + lower_length - 0.001, 0.05))
		if distance < 0.001:
			continue
		var direction: Vector3 = to_target.normalized()
		var along: float = (upper_length * upper_length - lower_length * lower_length + distance * distance) / (2.0 * distance)
		var height: float = sqrt(maxf(upper_length * upper_length - along * along, 0.0))
		var pole: Vector3 = Vector3.DOWN - direction * direction.dot(Vector3.DOWN)
		if pole.length_squared() < 0.001:
			pole = Vector3.BACK - direction * direction.dot(Vector3.BACK)
		pole = pole.normalized()
		var elbow: Vector3 = upper_pose.origin + direction * along + pole * height
		var upper_rotation: Quaternion = Quaternion((lower_pose.origin - upper_pose.origin).normalized(),
			(elbow - upper_pose.origin).normalized())
		skeleton.set_bone_global_pose_override(upper,
			Transform3D(Basis(upper_rotation) * upper_pose.basis, upper_pose.origin), 1.0, true)
		skeleton.force_update_all_bone_transforms()
		lower_pose = skeleton.get_bone_global_pose(lower)
		var lower_rotation: Quaternion = Quaternion((target - lower_pose.origin).normalized(),
			(target - elbow).normalized())
		skeleton.set_bone_global_pose_override(lower,
			Transform3D(Basis(lower_rotation) * lower_pose.basis, lower_pose.origin), 1.0, true)

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
