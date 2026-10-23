use bevy::prelude::{Deref, DerefMut, Resource};

pub use client_core::net::client::{ConnectOptions, NetEvent, unix_ms};

#[derive(Resource, Deref, DerefMut)]
pub struct NetHandle(pub client_core::net::client::NetHandle);

impl NetHandle {
    pub fn spawn(initial: Option<ConnectOptions>) -> Self {
        Self(client_core::net::client::NetHandle::spawn(initial))
    }
}
