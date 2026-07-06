use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Parameter type for a tool parameter.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ParamType {
    String,
    Number,
    Boolean,
}

impl From<&str> for ParamType {
    fn from(s: &str) -> Self {
        match s {
            "string" => ParamType::String,
            "number" => ParamType::Number,
            "boolean" => ParamType::Boolean,
            _ => ParamType::String,
        }
    }
}

/// Definition of a single tool parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: ParamType,
    pub description: String,
    pub required: bool,
    pub enum_vals: Option<Vec<String>>, // Corresponds to `enum` in TS
}

/// Definition of a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Vec<ToolParam>,
    // Optional JSON schema for Zod‑based generation.
    pub json_schema: Option<JsonSchema>,
}

/// Minimal JSON‑Schema representation used for Zod‑to‑GBNF conversion.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JsonSchema {
    #[serde(rename = "type")]
    pub typ: Option<String>,
    #[serde(rename = "enum")]
    pub enum_vals: Option<Vec<String>>, // enum values
    pub properties: Option<HashMap<String, JsonSchema>>,
    pub required: Option<Vec<String>>,
    pub items: Option<Box<JsonSchema>>, // not used currently
}
