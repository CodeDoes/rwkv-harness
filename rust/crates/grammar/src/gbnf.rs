use std::collections::HashMap;

use crate::types::{ToolDef, ToolParam, ParamType, JsonSchema};

/// Simple base rules required for parameter types.
fn base_rules() -> Vec<String> {
    vec![
        "prose-string ::= \"\\\"\"".to_string(), // placeholder for a quoted string
        "string-value ::= \"\\\"\"".to_string(), // placeholder
        "number-value ::= [0-9]+ (\".\" [0-9]+)?".to_string(),
        "boolean-value ::= \"true\" | \"false\"".to_string(),
        "ws ::= [ \t\n]*".to_string(),
    ]
}

/// Returns a rule that matches the tool name literal.
fn name_rule(tool: &ToolDef) -> String {
    let safe = tool.name.replace('_', "");
    format!(
        "{}name ::= \"\\\"name\\\"\" ws \" : \" ws \"\\\"{}\\\"\"",
        safe, tool.name
    )
}

/// Returns a rule that matches an (empty) argument object – for simplicity we ignore parameters.
fn args_rule(tool: &ToolDef) -> String {
    let safe = tool.name.replace('_', "");
    format!("{}args ::= \"{{\" ws \"}}\"", safe)
}

/// Returns the call rule for a tool.
fn call_rule(tool: &ToolDef) -> String {
    let safe = tool.name.replace('_', "");
    let cn = format!("call{}", safe);
    let name_ref = format!("{}name", safe);
    let args_ref = format!("{}args", safe);
    format!(
        "{} ::= \"\\t\" \"<tool_call>\" \"\\n\" \"\\t\" \"{{\" ws {} ws \",\" ws {} ws \"}}\" \"\\n\" \"\\t\" \"</tool_call>\"",
        cn, name_ref, args_ref
    )
}

/// Assembles a full grammar from a list of tool definitions.
fn assemble_grammar(defs: &[ToolDef], root_rule: &str) -> String {
    let mut lines = base_rules();
    let mut call_names = Vec::new();
    for t in defs {
        lines.push(name_rule(t));
        lines.push(args_rule(t));
        lines.push(call_rule(t));
        let safe = t.name.replace('_', "");
        call_names.push(format!("call{}", safe));
    }
    // Shared non‑terminal definitions.
    let shared = vec![
        r#"indented-line ::= ([^\n<] | "\n\t")*"#.to_string(),
        r#"think-block ::= "\t" "<think>" "\n" "\t" indented-line "\n\t" "</think>""#.to_string(),
        r#"text ::= "\t" indented-line"#.to_string(),
    ];
    let mut all = Vec::new();
    all.push(root_rule.to_string());
    all.extend(shared);
    all.extend(lines);
    all.push(format!("call ::= {}", call_names.join(" | ")));
    all.join("\n")
}

/// Generates a minimal tool‑only grammar (no surrounding text or think blocks).
pub fn tools_to_gbnf(defs: &[ToolDef]) -> String {
    assemble_grammar(defs, "root ::= call")
}

/// Generates a grammar that permits optional think blocks and free text surrounding tool calls.
pub fn tools_to_gbnf_with_think(defs: &[ToolDef]) -> String {
    assemble_grammar(
        defs,
        "root ::= ws? (think-block)* (call ws? | text call ws? | call text ws?)+ (text ws?)*",
    )
}

/// Helper for Zod‑based generation – builds the inner arguments rule from a JSON‑Schema.
fn prop_rule(schema: &JsonSchema) -> String {
    if let Some(enum_vals) = &schema.enum_vals {
        let alts: Vec<String> = enum_vals.iter().map(|v| format!("\"{}\"", v)).collect();
        return format!("({})", alts.join(" | "));
    }
    match schema.typ.as_deref() {
        Some("number") => "number-value".to_string(),
        Some("boolean") => "\"true\" | \"false\"".to_string(),
        _ => "string-value".to_string(),
    }
}

fn args_rules(_schema: &JsonSchema) -> String {
    // Simplified: accept any JSON object – the grammar just expects braces.
    "\"{\" ws \"}\"".to_string()
}

fn zod_to_tool_call_gbnf(tool_name: &str, _schema: &JsonSchema) -> String {
    // Simplified: ignore schema details.
    let name_rule = format!("\"name\" ws \" : \" ws \"{}\"", tool_name);
    let args_rule = format!("\"args\" ws \" : \" ws {}", args_rules(_schema));
    let safe = tool_name.replace('_', "");
    format!(
        "call{} ::= \"<tool_call>\" ws \"{{\" ws {} ws \",\" ws {} ws \"}}\"",
        safe, name_rule, args_rule
    )
}

fn build_tool_grammar(schemas: &HashMap<String, JsonSchema>) -> String {
    let mut lines = base_rules();
    let mut call_names = Vec::new();
    for (name, schema) in schemas {
        let safe = name.replace('_', "");
        lines.push(zod_to_tool_call_gbnf(name, schema));
        call_names.push(format!("call{}", safe));
    }
    let mut all = Vec::new();
    all.extend(lines);
    all.push(format!("call ::= {}", call_names.join(" | ")));
    all.join("\n")
}

/// Generates a GBNF grammar from a map of tool names to JSON‑Schema definitions.
pub fn tools_to_gbnf_zod(schemas: &HashMap<String, JsonSchema>) -> String {
    let root = "root ::= (think-block? ws)? text? ws call";
    let think = r#"think-block ::= "<think>" ([^<] | "<" [^/])* "</think>""#;
    let text = "text ::= [^<]+";
    let tool_grammar = build_tool_grammar(schemas);
    let mut parts = Vec::new();
    parts.push(root.to_string());
    parts.push(think.to_string());
    parts.push(text.to_string());
    parts.push(tool_grammar);
    parts.join("\n")
}

/// Minimal response‑only grammar (produces unrestricted free‑form text).
pub fn tools_to_gbnf_response() -> String {
    ["root ::= text \"\\n\\n\"", "text ::= [^<]*"].join("\n")
}

/// Renders tool definitions as a simple XML description.
pub fn tools_to_xml(defs: &[ToolDef]) -> String {
    let mut out = Vec::new();
    for t in defs {
        let mut params = Vec::new();
        for p in &t.parameters {
            let typ = match p.param_type {
                ParamType::String => "string",
                ParamType::Number => "number",
                ParamType::Boolean => "boolean",
            };
            let required = if p.required { " required=\"true\"" } else { "" };
            let param = format!(
                "  <parameter name=\"{}\" type=\"{}\"{}>{}</parameter>",
                p.name, typ, required, p.description
            );
            params.push(param);
        }
        let params_str = params.join("\n");
        let tool = format!(
            "<tool name=\"{}\" description=\"{}\">\n{}\n</tool>",
            t.name, t.description, params_str
        );
        out.push(tool);
    }
    out.join("\n\n")
}
