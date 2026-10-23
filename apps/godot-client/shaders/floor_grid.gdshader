shader_type spatial;
render_mode diffuse_burley, specular_schlick_ggx;

uniform vec4 base_color : source_color = vec4(0.035, 0.055, 0.075, 1.0);
uniform vec4 line_color : source_color = vec4(0.18, 0.62, 0.60, 1.0);
uniform vec4 accent_color : source_color = vec4(0.55, 0.42, 0.95, 1.0);
uniform float cell_size : hint_range(0.25, 4.0) = 1.0;
uniform float major_cells : hint_range(2.0, 16.0) = 8.0;
uniform float line_width : hint_range(0.25, 3.0) = 1.1;
uniform float glow_energy : hint_range(0.0, 8.0) = 2.2;
uniform float fade_start : hint_range(4.0, 40.0) = 15.0;
uniform float fade_end : hint_range(8.0, 64.0) = 42.0;
uniform sampler2D reflection : hint_default_black, filter_linear_mipmap;
uniform float reflection_strength : hint_range(0.0, 1.0) = 0.0;
uniform float metallic : hint_range(0.0, 1.0) = 0.18;
uniform mat4 reflection_view;
uniform mat4 reflection_projection;

varying vec3 world_position;

void vertex() {
	world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

float grid_line(vec2 coordinate, float width) {
	vec2 derivative = fwidth(coordinate);
	vec2 grid = abs(fract(coordinate - 0.5) - 0.5) / max(derivative, vec2(0.00001));
	return 1.0 - smoothstep(0.0, width, min(grid.x, grid.y));
}

void fragment() {
	vec2 minor_uv = world_position.xz / cell_size;
	vec2 major_uv = world_position.xz / (cell_size * major_cells);
	float minor = grid_line(minor_uv, line_width * 0.8);
	float major = grid_line(major_uv, line_width * 1.25);

	float distance_to_camera = distance(world_position.xz, CAMERA_POSITION_WORLD.xz);
	float fade = 1.0 - smoothstep(fade_start, fade_end, distance_to_camera);
	float radial = 1.0 - smoothstep(6.0, 34.0, length(world_position.xz));

	float line = max(minor * 0.32, major);
	vec3 line_tint = mix(line_color.rgb, accent_color.rgb, major * 0.85);

	ALBEDO = mix(base_color.rgb * 0.72, base_color.rgb, radial);
	ROUGHNESS = mix(0.3, 0.12, major);
	METALLIC = metallic;
	SPECULAR = 0.65;
	EMISSION = line_tint * line * glow_energy * fade;
	EMISSION += accent_color.rgb * radial * 0.018;

	if (reflection_strength > 0.0) {
		vec4 clip = reflection_projection * (reflection_view * vec4(world_position, 1.0));
		vec2 reflection_uv = clip.xy / max(clip.w, 0.0001) * 0.5 + 0.5;
		reflection_uv.y = 1.0 - reflection_uv.y;
		vec3 reflected = texture(reflection, reflection_uv).rgb * vec3(0.55, 0.72, 0.8);
		float fresnel = pow(1.0 - clamp(dot(normalize(NORMAL), normalize(VIEW)), 0.0, 1.0), 3.0);
		float amount = reflection_strength * (0.25 + 0.75 * fresnel) * fade;
		ALBEDO = mix(ALBEDO, reflected, amount * 0.62);
		EMISSION += reflected * amount * 0.15;
	}
}
