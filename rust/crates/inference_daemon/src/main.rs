//! Inference daemon – placeholder.
//!
//! The full daemon will own an `Engine` instance and expose RPC over a
//! WebSocket / HTTP transport.  For now this binary only confirms that
//! the engine trait can be constructed.

use std::sync::Arc;

use engine::{MockEngine, Engine};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    logging::init_console_log()?;
    let engine: Arc<dyn Engine> = Arc::new(MockEngine);
    tracing::info!("inference daemon would start with engine of type {}", std::any::type_name::<MockEngine>());
    Ok(())
}
