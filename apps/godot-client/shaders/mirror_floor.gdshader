shader_type spatial;
render_mode unshaded, cull_back;

uniform vec4 base_color : source_color = vec4(0.008, 0.015, 0.024, 1.0);
uniform vec4 line_color : source_color = vec4(0.08, 0.42, 0.4, 1.0);
uniform float cell_size : hint_range(0.25, 4.0) = 1.0;
uniform float major_cells : hint_range(2.0, 16.0) = 8.0;
uniform float line_width : hint_range(0.25, 3.0) = 1.0;

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
	float minor = grid_line(world_position.xz / cell_size, line_width * 0.8);
	float major = grid_line(world_position.xz / (cell_size * major_cells), line_width * 1.25);
	float line = max(minor * 0.3, major);
	ALBEDO = mix(base_color.rgb, line_color.rgb * 1.4, line);
}
