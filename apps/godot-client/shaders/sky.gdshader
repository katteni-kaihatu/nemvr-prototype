shader_type sky;

uniform vec4 zenith_color : source_color = vec4(0.015, 0.03, 0.075, 1.0);
uniform vec4 horizon_color : source_color = vec4(0.055, 0.16, 0.19, 1.0);
uniform vec4 ground_color : source_color = vec4(0.012, 0.02, 0.03, 1.0);
uniform vec4 glow_color : source_color = vec4(0.18, 0.72, 0.66, 1.0);
uniform vec4 sun_color : source_color = vec4(1.0, 0.78, 0.52, 1.0);
uniform float sun_sharpness : hint_range(64.0, 4096.0) = 1400.0;
uniform float sun_intensity : hint_range(0.0, 8.0) = 4.0;
uniform float star_scale : hint_range(80.0, 400.0) = 230.0;
uniform float star_intensity : hint_range(0.0, 2.0) = 0.55;
uniform float band_intensity : hint_range(0.0, 1.0) = 0.22;

float hash13(vec3 p) {
	p = fract(p * 0.1031);
	p += dot(p, p.yzx + 33.33);
	return fract((p.x + p.y) * p.z);
}

vec3 star_layer(vec3 direction, float scale) {
	vec3 point = direction * scale;
	vec3 cell = floor(point);
	vec3 offset = fract(point) - 0.5;
	float seed = hash13(cell);
	float star = (1.0 - smoothstep(0.0, 0.28, length(offset))) * step(0.9965, seed);
	float twinkle = 0.65 + 0.35 * sin(TIME * 2.4 + seed * 67.0);
	return vec3(0.72, 0.82, 1.0) * star * twinkle;
}

void sky() {
	vec3 direction = normalize(EYEDIR);
	float height = clamp(direction.y, -1.0, 1.0);
	float up = pow(clamp(height, 0.0, 1.0), 0.58);
	vec3 color = mix(horizon_color.rgb, zenith_color.rgb, up);
	color = mix(ground_color.rgb, color, smoothstep(-0.12, 0.015, height));

	float horizon_glow = exp(-abs(height) * 13.0);
	color += glow_color.rgb * horizon_glow * 0.22;

	float band = exp(-pow((height - 0.28) / 0.16, 2.0));
	color += vec3(0.055, 0.09, 0.16) * band * band_intensity;

	float visible = smoothstep(0.03, 0.3, height);
	color += star_layer(direction, star_scale) * star_intensity * visible;
	color += star_layer(direction, star_scale * 1.83) * star_intensity * 0.35 * visible;

	if (LIGHT0_ENABLED) {
		float sun = max(dot(direction, LIGHT0_DIRECTION), 0.0);
		color += LIGHT0_COLOR * pow(sun, sun_sharpness) * sun_intensity;
		color += sun_color.rgb * pow(sun, 7.0) * 0.055;
	}

	COLOR = color;
}
