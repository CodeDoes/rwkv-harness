use grammar::{tools_to_gbnf, tools_to_gbnf_with_think, tools_to_gbnf_zod, tools_to_gbnf_response};
use grammar::types::{ToolDef, ToolParam, ParamType, JsonSchema};
use schoolmarm::Grammar;
use std::collections::HashMap;

#[test]
fn test_tool_grammars_compile() {
    let defs = vec![
        ToolDef {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: vec![ToolParam {
                name: "path".to_string(),
                param_type: ParamType::String,
                description: "File path".to_string(),
                required: true,
                enum_vals: None,
            }],
            json_schema: None,
        },
        ToolDef {
            name: "write".to_string(),
            description: "Write a file".to_string(),
            parameters: vec![
                ToolParam {
                    name: "path".to_string(),
                    param_type: ParamType::String,
                    description: "File path".to_string(),
                    required: true,
                    enum_vals: None,
                },
                ToolParam {
                    name: "content".to_string(),
                    param_type: ParamType::String,
                    description: "File content".to_string(),
                    required: true,
                    enum_vals: None,
                },
            ],
            json_schema: None,
        },
    ];

    let gbnf = tools_to_gbnf(&defs);
    Grammar::new(&gbnf).expect("GBNF from tools_to_gbnf should compile");

    let gbnf_think = tools_to_gbnf_with_think(&defs);
    Grammar::new(&gbnf_think).expect("GBNF with think should compile");
}

#[test]
fn test_zod_grammar_compile() {
    let mut schemas: HashMap<String, JsonSchema> = HashMap::new();
    // read schema
    schemas.insert(
        "read".to_string(),
        JsonSchema {
            typ: Some("object".to_string()),
            properties: Some({
                let mut m = HashMap::new();
                m.insert(
                    "path".to_string(),
                    JsonSchema {
                        typ: Some("string".to_string()),
                        ..Default::default()
                    },
                );
                m
            }),
            required: Some(vec!["path".to_string()]),
            ..Default::default()
        },
    );
    // write schema
    schemas.insert(
        "write".to_string(),
        JsonSchema {
            typ: Some("object".to_string()),
            properties: Some({
                let mut m = HashMap::new();
                m.insert(
                    "path".to_string(),
                    JsonSchema {
                        typ: Some("string".to_string()),
                        ..Default::default()
                    },
                );
                m.insert(
                    "content".to_string(),
                    JsonSchema {
                        typ: Some("string".to_string()),
                        ..Default::default()
                    },
                );
                m
            }),
            required: Some(vec!["path".to_string(), "content".to_string()]),
            ..Default::default()
        },
    );

    let gbnf = tools_to_gbnf_zod(&schemas);
    Grammar::new(&gbnf).expect("GBNF from Zod schemas should compile");
}

#[test]
fn test_response_grammar_compile() {
    let gbnf = tools_to_gbnf_response();
    Grammar::new(&gbnf).expect("Response grammar should compile");
}
