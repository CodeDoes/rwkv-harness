//! Minimal in‑memory vector store with a deterministic bag‑of‑words
//! embedder.
//!
//! This is *not* a production‑grade embedding model – it’s just enough
//! to provide a working RAG‑like API and demo the workflow.  Replace
//! `embed()` with a real embedder (e.g. via `fastembed` or an external
//! service) when you wire a real model.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde::{Serialize, Deserialize};

const DIM: usize = 128;

/// Deterministic bag‑of‑words embedder.
/// Splits the text on whitespace, lower‑cases each token, hashes it
/// into one of `DIM` buckets and accumulates counts.  The vector is then
/// L2‑normalised so cosine similarity == dot product.
pub fn embed(text: &str) -> [f32; DIM] {
    let mut v = [0f32; DIM];
    for word in text.split_whitespace().map(|w| w.to_lowercase()) {
        // drop non‑alphabetic characters (very simple cleanup)
        let clean: String = word.chars().filter(|c| c.is_alphanumeric()).collect();
        if clean.is_empty() {
            continue;
        }
        let mut h = DefaultHasher::new();
        clean.hash(&mut h);
        let bucket = (h.finish() as usize) % DIM;
        v[bucket] += 1.0;
    }
    // L2 normalise
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    v
}

/// Compute cosine similarity for two already‑normalised vectors.
pub fn dot(a: &[f32; DIM], b: &[f32; DIM]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// An entry in the store: a stable id, the embedding, and the original
/// text (kept so we can return snippets verbatim when the caller asks
/// for them).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    pub id: String,
    pub text: String,
    pub vec: Vec<f32>,
}

/// In‑memory vector store.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Store {
    pub entries: Vec<Entry>,
}

impl Store {
    pub fn load_or_default(path: &std::path::Path) -> anyhow::Result<Self> {
        if path.exists() {
            let txt = std::fs::read_to_string(path)?;
            let store: Store = serde_json::from_str(&txt)?;
            Ok(store)
        } else {
            Ok(Self::default())
        }
    }

    pub fn save(&self, path: &std::path::Path) -> anyhow::Result<()> {
        let txt = serde_json::to_string_pretty(self)?;
        std::fs::write(path, txt)?;
        Ok(())
    }

    pub fn add(&mut self, id: String, text: String) {
        let v = embed(&text).to_vec();
        self.entries.push(Entry { id, text, vec: v });
    }

    /// Return the top‑`k` entries whose vector is closest (cosine) to
    /// the query.
    pub fn search(&self, query: &str, k: usize) -> Vec<(Entry, f32)> {
        let q = embed(query);
        let mut scored: Vec<(Entry, f32)> = self
            .entries
            .iter()
            .cloned()
            .map(|e| {
                let mut arr = [0f32; DIM];
                for (dst, src) in arr.iter_mut().zip(e.vec.iter()) {
                    *dst = *src;
                }
                let score = dot(&q, &arr);
                (e, score)
            })
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        scored
    }
}
