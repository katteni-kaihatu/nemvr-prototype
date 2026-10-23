use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub fn project_dirs() -> Option<directories::ProjectDirs> {
    directories::ProjectDirs::from("dev", "proto", "proto-client")
}

#[derive(Debug, Clone)]
pub struct ClientPaths {
    pub config_file: PathBuf,
    pub cache_dir: PathBuf,
    pub download_dir: PathBuf,
}

impl ClientPaths {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        if let Some(dir) = data_dir {
            return Self {
                config_file: dir.join("config.json"),
                cache_dir: dir.join("cache"),
                download_dir: dir.join("downloads"),
            };
        }
        let dirs = project_dirs();
        Self {
            config_file: dirs
                .as_ref()
                .map(|dirs| dirs.config_dir().join("config.json"))
                .unwrap_or_else(|| PathBuf::from("config.json")),
            cache_dir: dirs
                .map(|dirs| dirs.cache_dir().to_path_buf())
                .unwrap_or_else(|| PathBuf::from("cache")),
            download_dir: directories::UserDirs::new()
                .and_then(|dirs| dirs.download_dir().map(Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from(".")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        Self::load_from(&path)
    }

    pub fn load_from(path: &Path) -> Self {
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
        let _ = self.save_to(&dir.join("config.json"));
    }

    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        fs::write(path, text).map_err(|error| error.to_string())
    }

    pub fn http_base(&self) -> String {
        let Ok(mut url) = reqwest::Url::parse(&self.server) else {
            return "http://127.0.0.1:8080".into();
        };
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        let _ = url.set_scheme(scheme);
        url.origin().ascii_serialization()
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

    #[test]
    fn http_base_ignores_credentials_path_and_query() {
        let config = ClientConfig {
            server: "wss://user:secret@[::1]:9443/ws?token=secret".into(),
            ..Default::default()
        };
        assert_eq!(config.http_base(), "https://[::1]:9443");
    }

    #[test]
    fn data_directory_isolates_all_persistent_paths() {
        let root = PathBuf::from("isolated-client");
        let paths = ClientPaths::new(Some(root.clone()));
        assert_eq!(paths.config_file, root.join("config.json"));
        assert_eq!(paths.cache_dir, root.join("cache"));
        assert_eq!(paths.download_dir, root.join("downloads"));
    }
}
