shader_type canvas_item;

uniform vec4 tint : source_color = vec4(0.005, 0.012, 0.022, 1.0);
uniform float strength : hint_range(0.0, 1.0) = 0.42;

void fragment() {
	vec2 point = SCREEN_UV - vec2(0.5);
	float distance_from_center = length(point * vec2(1.0, 1.28));
	float alpha = smoothstep(0.3, 0.78, distance_from_center) * strength;
	COLOR = vec4(tint.rgb, alpha);
}
