//! Simple in‑memory caches shared by the inference path.
//!
//! This crate currently exposes:
//! - `PromptQueue`: ordered list of pending generation requests.
//! - `StateTuneCache`: hash → bytes map for reusable state tunings.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

/// Ordered FIFO queue of prompts awaiting generation.
#[derive(Debug, Default)]
pub struct PromptQueue {
    inner: Mutex<VecDeque<String>>,
}

impl PromptQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn push(&self, prompt: String) {
        self.inner.lock().unwrap().push_back(prompt);
    }
    pub fn pop(&self) -> Option<String> {
        self.inner.lock().unwrap().pop_front()
    }
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_queue_fifo() {
        let q = PromptQueue::new();
        q.push("a".into());
        q.push("b".into());
        assert_eq!(q.pop(), Some("a".into()));
        assert_eq!(q.pop(), Some("b".into()));
        assert_eq!(q.pop(), None);
    }
    #[test]
    fn tune_cache_put_get() {
        let c = StateTuneCache::new();
        c.put("k".into(), b"v".to_vec());
        assert_eq!(c.get("k"), Some(b"v".to_vec()));
    }
}
/// Simple key/value cache used for state‑tune reuse.
#[derive(Debug, Default)]
pub struct StateTuneCache {
    inner: Mutex<HashMap<String, Vec<u8>>>,
}

impl StateTuneCache {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.inner.lock().unwrap().get(key).cloned()
    }
    pub fn put(&self, key: String, value: Vec<u8>) {
        self.inner.lock().unwrap().insert(key, value);
    }
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}
