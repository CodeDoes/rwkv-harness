import { z } from "zod"
import { zodToJson } from "./zod-to-json.ts"
import type { JsonSchema } from "./zod-to-json.ts"

function propRule(schema: JsonSchema): string {
  if (schema.enum) return `enum-value`
  switch (schema.type) {
    case "number": return "number-value"
    case "boolean": return `boolean-value`
    default: return "string-value"
  }
}

function argsRules(schema: JsonSchema): string {
  const props = schema.properties
  const required = schema.required ?? []
  if (!props || Object.keys(props).length === 0) return `"{" ws "}"`
  const parts = Object.keys(props).map((key) => {
    const isReq = required.includes(key)
    const item = `"\\"${key}\\"" ws ":" ws ${propRule(props[key])}`
    return isReq ? item : `(${item})?`
  })
  return `"{" ws ${parts.join(` ws "," ws `)} ws "}"`
}

const BASE_RULES = [
  'string-value ::= "\\"" (string-char)* "\\""',
  `string-char ::= [^"\\\\] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])`,
  'number-value ::= [0-9]+ ("." [0-9]+)?',
  'ws ::= [ \\t\\n]*',
]

export function zodToToolCallGbnf(toolName: string, schema: z.ZodObject<z.ZodRawShape>): string {
  const jsonSchema = zodToJson(schema)
  const inner = argsRules(jsonSchema)
  const nameRule = `"\\"name\\"" ws ":" ws "\\"${toolName}\\""`
  const argsRule = `"\\"args\\"" ws ":" ws ${inner}`
  const safeName = toolName.replace(/_/g, "")
  return `call${safeName} ::= "<tool_call>" ws "{" ws ${nameRule} ws "," ws ${argsRule} ws "}" ws "</tool_call>"`
}

export function buildToolGrammar(schemas: Record<string, z.ZodObject<z.ZodRawShape>>): string {
  const entries = Object.entries(schemas)
  const callNames = entries.map(([name]) => `call${name.replace(/_/g, "")}`)
  const callRules = entries.map(([name, schema]) => zodToToolCallGbnf(name, schema))
  return [
    ...BASE_RULES,
    ...callRules,
    `call ::= ${callNames.join(" | ")}`,
  ].join("\n")
}

export function buildRootGrammar(schemas: Record<string, z.ZodObject<z.ZodRawShape>>): string {
  return [
    'root ::= (think-block? ws)? text? ws call',
    'think-block ::= "<think>" ([^<] | "<" [^/])* "</think>"',
    'text ::= [^<]+',
    buildToolGrammar(schemas),
  ].join("\n")
}
