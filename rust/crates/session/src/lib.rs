//! Session lifecycle helpers.
//!
//! A session owns a prompt history and an optional persisted checkpoint.
//! The state‑tune cache (delegated to `cache`) can be reused for fast
//! re‑hydration.

use std::sync::{Arc, Mutex};

use cache::StateTuneCache;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub updated_at: chrono_like::Timestamp,
}

pub mod chrono_like {
    //! Cheap stand‑in for chrono – we only need a Unix timestamp.
    pub type Timestamp = u64;
}

#[derive(Debug, Default)]
pub struct SessionManager {
    sessions: Mutex<Vec<SessionMeta>>,
    pub cache: Arc<StateTuneCache>,
}

impl SessionManager {
    pub fn new(cache: Arc<StateTuneCache>) -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(Vec::new()),
            cache,
        })
    }

    pub fn add(&self, meta: SessionMeta) {
        self.sessions.lock().unwrap().push(meta);
    }

    pub fn list(&self) -> Vec<SessionMeta> {
        self.sessions.lock().unwrap().clone()
    }
}
