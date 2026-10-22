use std::collections::VecDeque;

use space_protocol::projection::{Pose, Quat, Vec3};

const MAX_SAMPLES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub time: f64,
    pub pose: Pose,
}

#[derive(Debug, Clone, Default)]
pub struct PoseBuffer {
    samples: VecDeque<Sample>,
}

impl PoseBuffer {
    pub fn push(&mut self, time: f64, pose: Pose) {
        if self.samples.back().is_some_and(|last| time <= last.time) {
            return;
        }
        self.samples.push_back(Sample { time, pose });
        if self.samples.len() > MAX_SAMPLES {
            self.samples.pop_front();
        }
    }

    pub fn sample(&self, render_time: f64) -> Option<Pose> {
        let first = self.samples.front()?;
        let last = self.samples.back()?;
        if render_time <= first.time {
            return Some(first.pose);
        }
        if render_time >= last.time {
            return Some(last.pose);
        }

        for pair in self.samples.iter().rev().collect::<Vec<_>>().windows(2) {
            let next = pair[0];
            let prev = pair[1];
            if prev.time <= render_time {
                let span = next.time - prev.time;
                let t = if span > 0.0 {
                    (render_time - prev.time) / span
                } else {
                    1.0
                };
                return Some(lerp_pose(prev.pose, next.pose, t as f32));
            }
        }
        Some(last.pose)
    }
}

pub fn lerp_vec3(a: Vec3, b: Vec3, t: f32) -> Vec3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

pub fn slerp_quat(a: Quat, b: Quat, t: f32) -> Quat {
    let [mut bx, mut by, mut bz, mut bw] = b;
    let mut dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if dot < 0.0 {
        dot = -dot;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }

    let (s0, s1) = if dot > 0.9995 {
        (1.0 - t, t)
    } else {
        let theta = dot.clamp(-1.0, 1.0).acos();
        let sin = theta.sin();
        (((1.0 - t) * theta).sin() / sin, (t * theta).sin() / sin)
    };

    let x = a[0] * s0 + bx * s1;
    let y = a[1] * s0 + by * s1;
    let z = a[2] * s0 + bz * s1;
    let w = a[3] * s0 + bw * s1;
    let len = (x * x + y * y + z * z + w * w).sqrt();
    if len <= f32::EPSILON {
        [0.0, 0.0, 0.0, 1.0]
    } else {
        [x / len, y / len, z / len, w / len]
    }
}

pub fn lerp_pose(a: Pose, b: Pose, t: f32) -> Pose {
    Pose {
        position: lerp_vec3(a.position, b.position, t),
        head: slerp_quat(a.head, b.head, t),
        crouch: a.crouch + (b.crouch - a.crouch) * t,
        lean: a.lean + (b.lean - a.lean) * t,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pose(x: f32) -> Pose {
        Pose {
            position: [x, 0.0, 0.0],
            ..Pose::default()
        }
    }

    #[test]
    fn interpolates_between_samples() {
        let mut buffer = PoseBuffer::default();
        buffer.push(0.0, pose(0.0));
        buffer.push(100.0, pose(10.0));
        let sampled = buffer.sample(50.0).unwrap();
        assert!((sampled.position[0] - 5.0).abs() < 0.001);
    }

    #[test]
    fn does_not_extrapolate() {
        let mut buffer = PoseBuffer::default();
        buffer.push(0.0, pose(0.0));
        buffer.push(100.0, pose(10.0));
        assert_eq!(buffer.sample(200.0).unwrap().position[0], 10.0);
        assert_eq!(buffer.sample(-10.0).unwrap().position[0], 0.0);
    }

    #[test]
    fn ignores_out_of_order_samples() {
        let mut buffer = PoseBuffer::default();
        buffer.push(100.0, pose(10.0));
        buffer.push(50.0, pose(5.0));
        assert_eq!(buffer.sample(1000.0).unwrap().position[0], 10.0);
    }

    #[test]
    fn slerp_takes_the_short_path() {
        let a = [0.0, 0.0, 0.0, 1.0];
        let b = [0.0, 1.0, 0.0, 0.0];
        let mid = slerp_quat(a, b, 0.5);
        let half = std::f32::consts::FRAC_1_SQRT_2;
        assert!((mid[1] - half).abs() < 0.001);
        assert!((mid[3] - half).abs() < 0.001);
    }
}
