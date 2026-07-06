//! Engine abstraction.
//!
//! The `Engine` trait describes anything that can turn a prompt into a
//! sequence of `Chunk`s.  This mirrors the original TypeScript `Engine`
//! interface but in a Rust‑native, async‑stream shape.
//!
//! Concrete implementations wrap the actual RWKV model (via the native
//! binding) or a mock used for tests.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// A single streamed piece of output.
///
/// These align with Vercel's “Data Stream” protocol, so the UI side can
/// feed them directly to `assistant-ui`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum Chunk {
    /// Raw text chunk.
    Text(String),
    /// Tool‑call announcement (name + JSON args string).
    ToolCall { name: String, args: String },
    /// Stream finished.
    Done,
}

/// Generation options (subset of the original TypeScript `GenerateOpts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateOpts {
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_top_p")]
    pub top_p: f32,
}

fn default_temperature() -> f32 {
    0.8
}
fn default_top_p() -> f32 {
    0.9
}

impl Default for GenerateOpts {
    fn default() -> Self {
        Self {
            max_tokens: 256,
            temperature: default_temperature(),
            top_p: default_top_p(),
        }
    }
}

/// The core Engine trait.
#[async_trait]
pub trait Engine: Send + Sync {
    /// Generate a stream of `Chunk`s for the given prompt and optional grammar.
    async fn generate(
        &self,
        prompt: String,
        opts: GenerateOpts,
        grammar: Option<String>,
        sink: mpsc::Sender<Chunk>,
    ) -> anyhow::Result<()>;
}

/// A trivial, deterministic engine used for tests and as a placeholder.
pub struct MockEngine;

#[async_trait]
impl Engine for MockEngine {
    async fn generate(
        &self,
        prompt: String,
        _opts: GenerateOpts,
        _grammar: Option<String>,
        sink: mpsc::Sender<Chunk>,
    ) -> anyhow::Result<()> {
        // Just echo the prompt back in a few chunks.
        for word in prompt.split_whitespace() {
            sink.send(Chunk::Text(format!("{} ", word))).await?;
        }
        sink.send(Chunk::Done).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn mock_engine_streams_text() {
        let engine: Arc<dyn Engine> = Arc::new(MockEngine);
        let (tx, mut rx) = mpsc::channel(16);
        let prompt = "hello world".to_string();
        {
            let tx_clone = tx.clone();
            let engine_clone = engine.clone();
            let prompt_clone = prompt.clone();
            tokio::spawn(async move {
                engine_clone.generate(prompt_clone, GenerateOpts::default(), None, tx_clone).await.ok();
            });
        }
        drop(tx);
        let mut all = String::new();
        while let Some(chunk) = rx.recv().await {
            match chunk {
                Chunk::Text(t) => all.push_str(&t),
                Chunk::Done => break,
                _ => {}
            }
        }
        assert!(all.contains("hello"));
        assert!(all.contains("world"));
    }
}
