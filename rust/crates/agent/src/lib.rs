//! Agent loop.
//!
//! Wraps an `Engine` and a set of `ToolDef`s into a single entry point
//! that builds a grammar, runs the model, and streams the resulting
//! chunks back to the caller.
//!
//! This is the Rust analogue of the TypeScript `Loop`/`Agent` modules.
//! It intentionally stays small – the UI and protocol layer remain in
//! TypeScript.

use std::sync::Arc;

use engine::{Chunk, Engine, GenerateOpts};
use grammar::ToolDef;

pub struct Agent {
    pub engine: Arc<dyn Engine>,
    pub tools: Vec<ToolDef>,
}

impl Agent {
    pub fn new(engine: Arc<dyn Engine>, tools: Vec<ToolDef>) -> Self {
        Self { engine, tools }
    }

    /// Run the agent for a given prompt and forward all streamed chunks.
    pub fn tools_grammar(&self) -> String {
        grammar::tools_to_gbnf(&self.tools)
    }

    pub async fn run(
        &self,
        prompt: String,
        opts: GenerateOpts,
        sink: tokio::sync::mpsc::Sender<Chunk>,
    ) -> anyhow::Result<()> {
        // For brevity we don’t yet combine the prompt with the tool
        // grammar – that’s a next‑step TODO.
        self.engine.generate(prompt, opts, None, sink).await
    }
}
