//! Light wrappers around `tracing` for the harness.
//!
//! Two helpers are provided:
//! - `init_console_log` – sets up a pretty console subscriber.
//! - `flush` – ensures any buffered log entries are flushed.

use tracing_subscriber::{fmt, EnvFilter};
use anyhow::Result;

pub fn init_console_log() -> Result<()> {
    let env = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));
    fmt()
        .with_env_filter(env)
        .with_target(false)
        .compact()
        .try_init()
        .map_err(|e| anyhow::anyhow!("failed to install tracing subscriber: {e}"))
}

/// wait briefly (e.g. for tracing to flush) – no‑op for now.
pub async fn flush() {
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
}
