use bevy::prelude::{Deref, DerefMut, Resource};

pub use client_core::config::project_dirs;

#[derive(Debug, Clone, Default, Resource, Deref, DerefMut)]
pub struct ClientConfig(pub client_core::config::ClientConfig);

impl ClientConfig {
    pub fn load() -> Self {
        Self(client_core::config::ClientConfig::load())
    }
}
