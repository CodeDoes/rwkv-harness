use std::sync::Arc;
use std::net::SocketAddr;

use anyhow::Result;
use engine::{MockEngine, Engine};
use server::{router, AppState};

#[tokio::main]
async fn main() -> Result<()> {
    logging::init_console_log()?;
    tracing::info!("starting rwkv‑server");

    // For now we ship a MockEngine – later we'll wire the real RWKV
    // binding from `engine::rwkv.rs`.
    let engine: Arc<dyn Engine> = Arc::new(MockEngine);
    // Empty tool set for the minimal run.
    let tools = vec![];
    let state = AppState::new(engine, tools);

    let app = router(state);
    let addr: SocketAddr = "127.0.0.1:3000".parse()?;
    tracing::info!("listening on {}", addr);

    use tower::ServiceBuilder;
    use tower_http::trace::TraceLayer;
    let app = app.layer(ServiceBuilder::new().layer(TraceLayer::new_for_http()));

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on {}", addr);

    axum::serve(listener, app).await?;
    logging::flush().await;
    Ok(())
}
