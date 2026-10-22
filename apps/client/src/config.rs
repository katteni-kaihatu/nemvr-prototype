use std::fs;
use std::path::PathBuf;

use bevy::prelude::Resource;
use serde::{Deserialize, Serialize};

pub fn project_dirs() -> Option<directories::ProjectDirs> {
    directories::ProjectDirs::from("dev", "proto", "proto-client")
}

#[derive(Debug, Clone, Serialize, Deserialize, Resource)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientConfig {
    pub name: String,
    pub server: String,
    pub cache_max_mb: u64,
    pub volume: f32,
    pub avatar_path: Option<PathBuf>,
    pub avatar_cid: Option<String>,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            server: "ws://127.0.0.1:8080/ws".into(),
            cache_max_mb: 5120,
            volume: 0.8,
            avatar_path: None,
            avatar_cid: None,
        }
    }
}

impl ClientConfig {
    pub fn load() -> Self {
        let Some(dirs) = project_dirs() else {
            return Self::default();
        };
        let path = dirs.config_dir().join("config.json");
        fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(dirs) = project_dirs() else {
            return;
        };
        let dir = dirs.config_dir();
        if fs::create_dir_all(dir).is_err() {
            return;
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = fs::write(dir.join("config.json"), text);
        }
    }

    pub fn http_base(&self) -> String {
        let scheme = if self.server.starts_with("wss://") {
            "https"
        } else {
            "http"
        };
        let authority = self
            .server
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(&self.server)
            .split('/')
            .next()
            .unwrap_or("127.0.0.1:8080");
        format!("{scheme}://{authority}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_base_keeps_scheme_and_authority() {
        let ws = ClientConfig {
            server: "ws://127.0.0.1:8080/ws".into(),
            ..Default::default()
        };
        assert_eq!(ws.http_base(), "http://127.0.0.1:8080");

        let wss = ClientConfig {
            server: "wss://example.test/ws".into(),
            ..Default::default()
        };
        assert_eq!(wss.http_base(), "https://example.test");
    }
}
