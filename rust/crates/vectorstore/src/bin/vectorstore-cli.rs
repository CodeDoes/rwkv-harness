//! `vectorstore-cli` – a tiny helper that reads, writes and searches
//! the in‑memory JSON “vector store”.
//!
//! Sub‑commands:
//!
//! ```text
//! vectorstore-cli add <id> <text…>          # add a document
//! vectorstore-cli store <filepath>          # print the JSON dump
//! vectorstore-cli search <query> [k]        # top‑k search
//! ```
//!
//! The store lives in a JSON file (default: `vectors.json`).

use std::env;
use std::path::PathBuf;

use vectorstore::Store;

fn main() -> anyhow::Result<()> {
    let store_path: PathBuf = env::var("VECTOR_STORE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("vectors.json"));

    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: vectorstore-cli <add|store|search> …");
        std::process::exit(1);
    }

    let mut store = Store::load_or_default(&store_path)?;
    match args[1].as_str() {
        "add" => {
            if args.len() < 4 {
                eprintln!("usage: vectorstore-cli add <id> <text…>");
                std::process::exit(1);
            }
            let id = args[2].clone();
            let text = args[3..].join(" ");
            store.add(id, text);
            store.save(&store_path)?;
            println!("added")
        }
        "store" => {
            let txt = serde_json::to_string_pretty(&store)?;
            println!("{txt}");
        }
        "search" => {
            if args.len() < 3 {
                eprintln!("usage: vectorstore-cli search <query> [k]");
                std::process::exit(1);
            }
            let query = args[2..].join(" ");
            let k: usize = if args.len() > 3 {
                args[3].parse().unwrap_or(5)
            } else {
                5
            };
            for (i, (e, score)) in store.search(&query, k).iter().enumerate() {
                println!("#{i:>2}  score={score:.4}  id={}  {:->40}", e.id, e.text)
            }
        }
        other => {
            eprintln!("unknown sub‑command: {other}");
            std::process::exit(1);
        }
    }
    Ok(())
}
