use std::path::PathBuf;

use client_core::{ClientSession, collision, movement};
use godot::builtin::{VarArray, VarDictionary, VariantType, vdict};
use godot::classes::{IRefCounted, RefCounted};
use godot::prelude::*;
use image::ImageDecoder;
use serde_json::{Value, json};

struct ProtoExtension;

// All engine values are converted on Godot's main thread. The core's workers
// exchange owned Rust data and never retain Godot objects.
#[gdextension]
unsafe impl ExtensionLibrary for ProtoExtension {}

#[derive(GodotClass)]
#[class(base=RefCounted)]
struct ProtoClient {
    session: ClientSession,
    base: Base<RefCounted>,
}

#[godot_api]
impl IRefCounted for ProtoClient {
    fn init(base: Base<RefCounted>) -> Self {
        Self {
            session: ClientSession::new(None),
            base,
        }
    }
}

#[godot_api]
impl ProtoClient {
    #[func]
    fn new_id(&self) -> GString {
        GString::from(uuid::Uuid::new_v4().to_string().as_str())
    }

    #[func]
    fn decode_image(&self, path: GString) -> VarDictionary {
        match decode_image(&PathBuf::from(path.to_string())) {
            Ok(image) => {
                let pixels = PackedByteArray::from(image.as_raw().as_slice());
                vdict! { "ok" => true, "width" => image.width(), "height" => image.height(), "rgba" => &pixels }
            }
            Err(error) => vdict! { "ok" => false, "error" => error.as_str() },
        }
    }

    #[func]
    fn configure(&mut self, data_dir: GString) {
        let path = data_dir.to_string();
        self.session = ClientSession::new((!path.is_empty()).then(|| PathBuf::from(path)));
    }

    #[func]
    fn command(&mut self, payload: VarDictionary) -> VarDictionary {
        match from_variant(&payload.to_variant(), 0)
            .and_then(|command| self.session.dispatch(command))
        {
            Ok(value) => vdict! { "ok" => true, "value" => &to_variant(&value) },
            Err(error) => vdict! { "ok" => false, "error" => error.as_str() },
        }
    }

    #[func]
    fn poll_events(&mut self) -> Array<VarDictionary> {
        self.session
            .poll()
            .iter()
            .filter_map(|event| to_variant(event).try_to::<VarDictionary>().ok())
            .collect()
    }

    #[func]
    fn step_movement(
        &self,
        state: VarDictionary,
        input: VarDictionary,
        delta: f64,
    ) -> VarDictionary {
        let Ok(state) = from_variant(&state.to_variant(), 0) else {
            return VarDictionary::new();
        };
        let Ok(input) = from_variant(&input.to_variant(), 0) else {
            return VarDictionary::new();
        };
        to_variant(&step_movement(&state, &input, delta as f32))
            .try_to::<VarDictionary>()
            .unwrap_or_default()
    }

    #[func]
    fn resolve_collision(
        &self,
        position: Vector3,
        height: f64,
        obstacles: VarArray,
    ) -> VarDictionary {
        if !position.is_finite() || !height.is_finite() || !(0.1..=10.0).contains(&height) {
            return vdict! { "position" => position, "grounded" => false, "hitCeiling" => false };
        }
        let colliders: Vec<_> = obstacles
            .iter_shared()
            .take(4096)
            .filter_map(|value| from_variant(&value, 0).ok())
            .filter_map(|value| serde_json::from_value(value).ok())
            .filter_map(|entity| space_protocol::projection::project_entity(&entity))
            .filter_map(|object| collision::collider_for(&object))
            .collect();
        let resolved = collision::resolve_player(
            [position.x, position.y, position.z].into(),
            height as f32,
            &colliders,
        );
        let p = resolved.position.to_array();
        vdict! {
            "position" => Vector3::new(p[0], p[1], p[2]),
            "grounded" => resolved.grounded,
            "hitCeiling" => resolved.hit_ceiling
        }
    }
}

fn decode_image(path: &std::path::Path) -> Result<image::RgbaImage, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 24 * 1024 * 1024 {
        return Err("image exceeds 24 MiB".into());
    }
    let mut reader = image::ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 16_777_216 {
        return Err("image exceeds 16 megapixels".into());
    }
    let image = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    Ok(image.into_rgba8())
}

fn number(value: &Value, key: &str, fallback: f32) -> f32 {
    value[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .map(|n| n as f32)
        .unwrap_or(fallback)
}

fn step_movement(state: &Value, input: &Value, delta: f32) -> Value {
    let dt = if delta.is_finite() {
        delta.clamp(0.0, 0.05)
    } else {
        0.0
    };
    let p = state["position"].as_array();
    let coordinate = |i: usize| {
        p.and_then(|p| p.get(i))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .unwrap_or(0.0) as f32
    };
    let vertical = movement::step_vertical(
        movement::Vertical {
            y: coordinate(1),
            vy: number(state, "vy", 0.0),
            crouch: number(state, "crouch", 0.0),
            grounded: state["grounded"].as_bool().unwrap_or(true),
            air_jumps: state["airJumps"].as_u64().unwrap_or(1).min(1) as u8,
        },
        movement::VerticalInput {
            jump: input["jump"].as_bool().unwrap_or(false),
            jump_pressed: input["jumpPressed"].as_bool().unwrap_or(false),
            crouch: input["crouch"].as_bool().unwrap_or(false),
        },
        dt,
    );
    let yaw = number(input, "yaw", number(state, "yaw", 0.0));
    let mut x = number(input, "moveX", 0.0).clamp(-1.0, 1.0);
    let mut z = number(input, "moveZ", 0.0).clamp(-1.0, 1.0);
    let length = x.hypot(z).max(1.0);
    x /= length;
    z /= length;
    let speed = movement::WALK_SPEED
        * movement::move_speed_factor(vertical.crouch, input["sprint"].as_bool().unwrap_or(false));
    let (s, c) = yaw.sin_cos();
    let limit = movement::WORLD_HALF_SIZE;
    let lean = movement::step_lean(number(state, "lean", 0.0), number(input, "lean", 0.0), dt);
    let eye = movement::eye_height_for(vertical.crouch);
    let pose = movement::lean_pose(eye, lean);
    json!({
        "position": [(coordinate(0) + (c*x+s*z)*speed*dt).clamp(-limit,limit), vertical.y,
            (coordinate(2) + (-s*x+c*z)*speed*dt).clamp(-limit,limit)],
        "vy": vertical.vy, "crouch": vertical.crouch,
        "grounded": vertical.grounded, "airJumps": vertical.air_jumps,
        "lean": lean, "yaw": yaw, "eyeHeight": eye,
        "leanSide": pose.side, "leanHeight": pose.height, "leanRoll": pose.roll
    })
}

fn from_variant(value: &Variant, depth: usize) -> Result<Value, String> {
    if depth > 48 {
        return Err("value nesting limit exceeded".into());
    }
    match value.get_type() {
        VariantType::NIL => Ok(Value::Null),
        VariantType::BOOL => Ok(Value::Bool(value.to::<bool>())),
        VariantType::INT => Ok(Value::from(value.to::<i64>())),
        VariantType::FLOAT => serde_json::Number::from_f64(value.to::<f64>())
            .map(Value::Number)
            .ok_or_else(|| "non-finite number".into()),
        VariantType::STRING | VariantType::STRING_NAME => {
            Ok(Value::String(value.stringify().to_string()))
        }
        VariantType::ARRAY => value
            .try_to::<VarArray>()
            .map_err(|_| "expected an untyped array".to_owned())?
            .iter_shared()
            .map(|value| from_variant(&value, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        VariantType::DICTIONARY => {
            let dict = value
                .try_to::<VarDictionary>()
                .map_err(|_| "expected an untyped dictionary".to_owned())?;
            let mut object = serde_json::Map::new();
            for (key, value) in dict.iter_shared() {
                if !matches!(
                    key.get_type(),
                    VariantType::STRING | VariantType::STRING_NAME
                ) {
                    return Err("dictionary keys must be strings".into());
                }
                object.insert(
                    key.stringify().to_string(),
                    from_variant(&value, depth + 1)?,
                );
            }
            Ok(Value::Object(object))
        }
        _ => Err("only JSON-compatible values cross the session boundary".into()),
    }
}

fn to_variant(value: &Value) -> Variant {
    match value {
        Value::Null => Variant::nil(),
        Value::Bool(value) => value.to_variant(),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                integer.to_variant()
            } else {
                value.as_f64().unwrap_or(0.0).to_variant()
            }
        }
        Value::String(value) => GString::from(value.as_str()).to_variant(),
        Value::Array(values) => values
            .iter()
            .map(to_variant)
            .collect::<VarArray>()
            .to_variant(),
        Value::Object(values) => {
            let mut dict = VarDictionary::new();
            for (key, value) in values {
                dict.set(key.as_str(), &to_variant(value));
            }
            dict.to_variant()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensionless_cache_decodes_png_and_gif_first_frame() {
        let directory = std::env::temp_dir().join(format!("proto-image-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            3,
            2,
            image::Rgba([20, 100, 200, 255]),
        ));
        for (index, format) in [image::ImageFormat::Png, image::ImageFormat::Gif]
            .into_iter()
            .enumerate()
        {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image.write_to(&mut bytes, format).unwrap();
            let path = directory.join(index.to_string());
            std::fs::write(&path, bytes.into_inner()).unwrap();
            let decoded = decode_image(&path).unwrap();
            assert_eq!(decoded.dimensions(), (3, 2));
            assert_eq!(decoded.get_pixel(0, 0).0, [20, 100, 200, 255]);
        }
        let path = directory.join("invalid");
        std::fs::write(&path, b"not an image").unwrap();
        assert!(decode_image(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn movement_uses_shared_rules_and_bounds() {
        let initial = json!({"position":[0,0,0],"grounded":true});
        let next = step_movement(&initial, &json!({"moveZ":-1,"jump":true}), 1.0 / 60.0);
        assert!(next["position"][1].as_f64().unwrap() > 0.0);
        assert!(next["position"][2].as_f64().unwrap() < 0.0);
        assert_eq!(next["airJumps"], 1);
        let next = step_movement(&initial, &json!({"moveX":1}), f32::NAN);
        assert_eq!(next["position"], json!([0.0, 0.0, 0.0]));
    }
}
