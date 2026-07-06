//! Evaluation harness – placeholder.
//!
//! The full version will iterate through a list of
//! "(prompt, expected‑tool‑calls)" pairs and verify the generated grammar.

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    logging::init_console_log()?;
    tracing::info!("eval binary placeholder – nothing to run yet");
    Ok(())
}
