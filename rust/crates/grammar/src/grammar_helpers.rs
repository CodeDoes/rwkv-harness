use regex::Regex;
use std::collections::{HashMap, HashSet};

/// Representation of a parsed GBNF grammar.
#[derive(Debug, Clone)]
pub struct ParsedGrammar {
    pub definitions: HashMap<String, String>,
    pub order: Vec<String>,
}

/// Parses a GBNF string into a `ParsedGrammar`.
///
/// Returns a `ParsedGrammar` on success or panics on malformed input.
pub fn parse_grammar(gbnf: &str) -> ParsedGrammar {
    let mut definitions = HashMap::new();
    let mut order = Vec::new();
    let ident_re = Regex::new(r"^[a-zA-Z_][a-zA-Z0-9_-]*$").unwrap();

    for raw_line in gbnf.lines() {
        // Strip comments (starting with #) and trim whitespace.
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let eq_idx = line.find("::=").expect(&format!("line missing '::=': {}", line));
        let name = line[..eq_idx].trim();
        let rhs = line[eq_idx + 3..].trim();
        assert!(ident_re.is_match(name), "invalid rule identifier: {}", name);
        assert!(!definitions.contains_key(name), "duplicate rule definition: {}", name);
        definitions.insert(name.to_string(), rhs.to_string());
        order.push(name.to_string());
    }
    ParsedGrammar { definitions, order }
}

/// Collects every identifier appearing on the RHS that is *not* a literal or character class.
pub fn rhs_identifiers(rhs: &str) -> HashSet<String> {
    let mut ids = HashSet::new();
    // Remove all string literals "..." (including escaped quotes).
    let without_strings = Regex::new(r#"\"(?:\\.|[^\"\\])*\""#).unwrap().replace_all(rhs, "");
    // Remove character classes [...]
    let without_classes = Regex::new(r"\[[^\]]*\]").unwrap().replace_all(&without_strings, "");
    let re = Regex::new(r"\b[a-zA-Z_][a-zA-Z0-9_-]*\b").unwrap();
    for cap in re.captures_iter(&without_classes) {
        ids.insert(cap[0].to_string());
    }
    ids
}

/// An issue found when validating a GBNF grammar.
#[derive(Debug, Clone)]
pub struct GrammarIssue {
    pub name: String,
    pub message: String,
}

/// Validates a GBNF string similarly to `schoolmarm::Grammar::new`.
///
/// Checks:
///   1. Every line contains `::=` (or is blank / comment).
///   2. Rule identifiers match the identifier regex.
///   3. No duplicate rule definitions.
///   4. No dangling alternation pipes (`|` at start or end of RHS).
///   5. Every identifier on the RHS resolves to a defined rule.
pub fn validate_grammar_full(gbnf: &str) -> Vec<GrammarIssue> {
    let mut issues = Vec::new();
    let parsed = match std::panic::catch_unwind(|| parse_grammar(gbnf)) {
        Ok(p) => p,
        Err(e) => {
            let msg = if let Some(s) = e.downcast_ref::<&str>() { *s } else { "unknown" };
            issues.push(GrammarIssue { name: "<parse>".to_string(), message: msg.to_string() });
            return issues;
        }
    };
    let defined: HashSet<String> = parsed.definitions.keys().cloned().collect();
    for (name, rhs) in parsed.definitions.iter() {
        if Regex::new(r"^\s*\|").unwrap().is_match(rhs) || Regex::new(r"\|\s*$").unwrap().is_match(rhs) {
            issues.push(GrammarIssue { name: name.clone(), message: "dangling alternation pipe".to_string() });
        }
        for ref_id in rhs_identifiers(rhs) {
            if !defined.contains(&ref_id) {
                issues.push(GrammarIssue { name: name.clone(), message: format!("unresolved rule reference: {}", ref_id) });
            }
        }
    }
    issues
}
