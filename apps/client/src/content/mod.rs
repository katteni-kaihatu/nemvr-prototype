use bevy::prelude::{Deref, DerefMut, Resource};

pub use client_core::content::ContentEvent;
#[cfg(feature = "ipfs")]
pub use client_core::content::ipfs;

#[derive(Resource, Deref, DerefMut)]
pub struct ContentService(pub client_core::content::ContentService);

impl ContentService {
    pub fn spawn(http_base: String) -> Self {
        Self(client_core::content::ContentService::spawn(http_base))
    }
}
