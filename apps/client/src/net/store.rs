use bevy::prelude::{Deref, DerefMut, Resource};

pub use client_core::net::store::ApplyError;

#[derive(Debug, Clone, Default, Resource, Deref, DerefMut)]
pub struct SpaceStore(pub client_core::net::store::SpaceStore);
