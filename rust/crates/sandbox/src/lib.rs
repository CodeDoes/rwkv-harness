//! Simple temp‑dir helpers – reused by logging, session, etc.

use anyhow::Result;
use std::path::PathBuf;

/// Returns a fresh temporary directory inside the OS temp area.
///
/// The directory is created automatically; callers are responsible for
/// removing it when finished.
pub fn fresh_temp_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("rwkv-{}", uuid_like()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn uuid_like() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut h = DefaultHasher::new();
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .hash(&mut h);
    format!("{:x}", h.finish())
}
