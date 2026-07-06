//! `grammar-debug` – a tiny command‑line helper that inspects a GBNF
//! grammar and, optionally, feeds a sample text through `schoolmarm`’s
//! `GrammarState` to pinpoint where the grammar stops accepting input.
//!
//! ```text
//! $ grammar-debug examples/sample.gbnf "some text"
//! ```
//!
//! The program prints:
//!   • a listing of every rule (`NAME ::= RHS`) that the parser
//!     recognised,
//!   • any validation issues (dangling `|`, unresolved rule
//!     references, duplicate definitions),
//!   • whether `schoolmarm::Grammar::new` compiles the input,
//!   • for each character of the optional `<text>` argument: the
//!     character index where the grammar first rejects input (or that
//!     the text was fully accepted).

use std::{env, fs, process};

use grammar::{parse_grammar, validate_grammar_full, GrammarIssue, ParsedGrammar};
use schoolmarm::{Grammar, GrammarState};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 || args.len() > 3 {
        eprintln!("usage: grammar-debug <gbnf-file> [text]");
        process::exit(1);
    }
    let path = &args[1];
    let gbnf = fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("failed to read {path}: {e}");
        process::exit(1);
    });

    // ── 1️⃣  Structural parse via `grammar`’s helper. ────────────────────────
    let parsed = parse_grammar(&gbnf);
    print_rules(&parsed);

    // ── 2️⃣  Validation issues. ───────────────────────────────────────────────
    let issues = validate_grammar_full(&gbnf);
    print_issues(&issues);

    // ── 3️⃣  Compile with schoolmarm. ────────────────────────────────────────
    let grammar = match Grammar::new(&gbnf) {
        Ok(g) => {
            println!("\n✅  schoolmarm compiled the grammar");
            g
        }
        Err(e) => {
            eprintln!("\n❌  schoolmarm error: {e}");
            return;
        }
    };

    // ── 4️⃣  Optional text walk. ─────────────────────────────────────────────
    if args.len() == 3 {
        let text = &args[2];
        walk_text(&grammar, text);
    }
}

/* ------------------------------------------------------------- helpers -- */

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn print_rules(parsed: &ParsedGrammar) {
    println!("📖  {} rules parsed:", parsed.definitions.len());
    for name in &parsed.order {
        let rhs = parsed
            .definitions
            .get(name)
            .map(|s| truncate(s, 120))
            .unwrap_or_else(|| "(missing)".to_string());
        println!("    {:<20} ::=  {}", name, rhs);
    }
}

fn print_issues(issues: &[GrammarIssue]) {
    println!("\n🔍  {} validation issue(s):", issues.len());
    if issues.is_empty() {
        println!("    (none – the grammar is structurally clean)");
        return;
    }
    for issue in issues {
        println!("    - `{}`: {}", issue.name, issue.message);
    }
}

/// Try to accept every character of `text`.  Returns the index of the
/// first char that the grammar rejects (or `None` if all chars were
/// taken but the state never reached a valid final state).
fn walk_text(grammar: &Grammar, text: &str) {
    println!("\n🧪  walking `{}` ({} char(s)) through the grammar …", text, text.chars().count());
    let mut state = match GrammarState::new(grammar.clone()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("❌  could not create GrammarState: {e}");
            return;
        }
    };

    let mut bad_idx: Option<usize> = None;
    for (i, c) in text.chars().enumerate() {
        if state.accept_token(&c.to_string()).is_err() {
            bad_idx = Some(i);
            break;
        }
    }

    match bad_idx {
        Some(i) => {
            println!("    ✗ grammar rejected char #{} ({:?})", i, text.chars().nth(i).unwrap());
            println!("    context: …{}…", truncate(&text[..i], 60));
        }
        None => {
            if state.is_valid() {
                println!("    🎉 text fully accepted and grammar reached a valid finishing state");
            } else {
                println!("    ⚠️  text accepted all chars but grammar never reached a valid finishing state");
            }
        }
    }
}
