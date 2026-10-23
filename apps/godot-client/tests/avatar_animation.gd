extends SceneTree

const Animator = preload("res://scripts/avatar_animator.gd")
var failures := 0
var checks := 0


func _check(condition: bool, label: String) -> void:
	checks += 1
	if not condition:
		failures += 1
		push_error("AVATAR_ANIMATION failed: " + label)


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	var skeleton := Skeleton3D.new()
	skeleton.name = "Skeleton3D"
	root.add_child(skeleton)
	var names := ["hips", "spine", "chest", "neck", "head",
		"leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm",
		"leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg",
		"leftFoot", "rightFoot"]
	var mapping := {}
	for name: String in names:
		skeleton.add_bone(name)
		mapping[name] = name
	var animator: Node = Animator.new()
	animator.name = "AvatarAnimator"
	skeleton.add_child(animator)
	animator.call("setup", skeleton, mapping)
	_check(animator.bones.size() == names.size(), "all humanoid bones map")
	var left_leg := skeleton.find_bone("leftUpperLeg")
	var rest_leg := skeleton.get_bone_pose_rotation(left_leg)
	var rest_arm := skeleton.get_bone_pose_rotation(skeleton.find_bone("leftUpperArm"))

	animator.call("set_motion", 2.0, 0.0)
	animator.call("_process", 0.4)
	var walking_leg := skeleton.get_bone_pose_rotation(left_leg)
	_check(not walking_leg.is_equal_approx(rest_leg), "walking changes leg pose")
	_check(not skeleton.get_bone_pose_rotation(skeleton.find_bone("leftUpperArm")).is_equal_approx(rest_arm),
		"arms settle out of T-pose")

	animator.call("set_motion", 0.0, 0.8)
	animator.call("_process", 0.5)
	var hips := skeleton.find_bone("hips")
	_check(skeleton.get_bone_pose_position(hips).y < -0.1, "crouch lowers hips")

	animator.call("set_motion", 0.0, 0.0)
	for _i in 20:
		animator.call("_process", 0.1)
	_check(absf(skeleton.get_bone_pose_position(hips).y) < 0.05, "idle returns hips to rest")

	print("AVATAR_ANIMATION " + JSON.stringify({"checks": checks, "failures": failures}))
	quit(0 if failures == 0 else 1)
