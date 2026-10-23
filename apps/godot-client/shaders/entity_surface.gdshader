shader_type spatial;
render_mode diffuse_burley, specular_schlick_ggx;

uniform vec4 albedo : source_color = vec4(0.62, 0.72, 0.78, 1.0);
uniform float smoothness : hint_range(0.0, 1.0) = 0.62;
uniform float rim_strength : hint_range(0.0, 2.0) = 1.1;
uniform float emission_strength : hint_range(0.0, 1.0) = 0.012;
uniform float scan_strength : hint_range(0.0, 0.25) = 0.05;

varying vec3 world_normal;
varying vec3 world_position;

void vertex() {
	world_normal = normalize((MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz);
	world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	float facing = clamp(dot(normalize(NORMAL), normalize(VIEW)), 0.0, 1.0);
	float rim = pow(1.0 - facing, 2.4);
	float top_light = clamp(world_normal.y * 0.5 + 0.5, 0.0, 1.0);
	vec3 base = albedo.rgb * mix(0.46, 1.1, top_light);
	float scan = 1.0 - smoothstep(0.0, 0.055, abs(fract(world_position.y * 7.0 - TIME * 0.18) - 0.5));

	ALBEDO = base;
	ROUGHNESS = 1.0 - smoothness;
	METALLIC = 0.24;
	SPECULAR = 0.75;
	RIM = 0.9;
	RIM_TINT = 0.7;
	vec2 edge = min(UV, vec2(1.0) - UV);
	float border = 1.0 - smoothstep(0.0, 0.045, min(edge.x, edge.y));
	EMISSION = base * (emission_strength + rim * rim_strength * 0.42);
	EMISSION += base * scan * scan_strength;
	EMISSION += base * border * 0.14;
}
