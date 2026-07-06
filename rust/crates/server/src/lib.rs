//! HTTP server crate.
//!
//! Exposes a minimal API surface that mirrors what the TypeScript side
//! needs:
//! - `POST /rpc/generate`  – non‑streaming generation.
//! - `POST /rpc/grammar`   – build a GBNF grammar from tool names.
//! - `GET  /rpc/health`    – liveness probe.
//! - `GET  /rpc/sessions`  – lists sessions (stub).
//!
//! When you switch to the full orpc contract you only need to replace
//! these handlers – the state wiring (`AppState`) stays the same.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use engine::{Chunk, GenerateOpts};
use serde::{Deserialize, Serialize};

use agent::Agent;
use cache::{PromptQueue, StateTuneCache};
use grammar::ToolDef;
use session::SessionManager;

/// Shared state injected into all handlers.
#[derive(Clone)]
pub struct AppState {
    pub agent: Arc<Agent>,
    pub queue: Arc<PromptQueue>,
    pub sessions: Arc<SessionManager>,
    pub tune_cache: Arc<StateTuneCache>,
}

impl AppState {
    /// Build a default state with the supplied engine implementation.
    pub fn new(engine: Arc<dyn engine::Engine>, tools: Vec<ToolDef>) -> Self {
        let agent = Arc::new(Agent::new(engine, tools));
        let queue = PromptQueue::new();
        let tune_cache = StateTuneCache::new();
        let sessions = SessionManager::new(tune_cache.clone());
        Self {
            agent,
            queue,
            sessions,
            tune_cache,
        }
    }
}

/// Request body for `POST /rpc/generate`.
#[derive(Debug, Deserialize)]
pub struct GenerateBody {
    pub prompt: String,
    #[serde(default)]
    pub opts: Option<GenerateOpts>,
}

/// Response body for `POST /rpc/generate` (non‑streaming).
#[derive(Debug, Serialize)]
pub struct GenerateResponse {
    pub chunks: Vec<Chunk>,
}

/// Build the Axum router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/rpc/health", get(health))
        .route("/rpc/sessions", get(list_sessions))
        .route("/rpc/generate", post(generate))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn list_sessions(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    Ok(Json(serde_json::json!({ "sessions": state.sessions.list() })))
}

async fn generate(
    State(state): State<AppState>,
    Json(body): Json<GenerateBody>,
) -> Result<Json<GenerateResponse>, StatusCode> {
    let opts = body.opts.unwrap_or_default();
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Chunk>(64);
    let prompt = body.prompt.clone();
    let agent = state.agent.clone();
    // Spawn the generation in the background, collect everything.
    let handle = tokio::spawn(async move {
        if let Err(e) = agent.run(prompt, opts, sender).await {
            tracing::warn!("generation failed: {e}");
        }
    });
    let mut out: Vec<Chunk> = Vec::new();
    while let Some(chunk) = receiver.recv().await {
        out.push(chunk);
    }
    let _ = handle.await;
    Ok(Json(GenerateResponse { chunks: out }))
}
