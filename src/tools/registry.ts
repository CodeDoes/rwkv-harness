import { z } from "zod"
import { ToolDef, ToolHandler, ToolParam } from "../types.ts"
import { buildRootGrammar } from "./utils/zod-to-gbnf.ts"
import file_read from "./read.ts"
import file_write from "./write.ts"
import file_edit from "./edit.ts"
import findTool from "./find.ts"
import mkdirTool from "./mkdir.ts"
import lsTool from "./ls.ts"
import grepTool from "./grep.ts"

const sharedDefs = {
  read: { schema: z.object({ path: z.string().describe("File path") }) },
  write: { schema: z.object({ path: z.string().describe("File path"), content: z.string().describe("File content") }) },
  edit: { schema: z.object({ path: z.string().describe("File path"), find: z.string().describe("Text to find"), replace: z.string().describe("Replacement text") }) },
  ls: { schema: z.object({ path: z.string().describe("Directory path"), recursive: z.boolean().optional().describe("If true, walk subdirectories and return file paths") }) },
  mkdir: { schema: z.object({ path: z.string().describe("Directory path") }) },
  grep: { schema: z.object({ path: z.string().describe("Directory to search"), term: z.string().describe("Text to search for") }) },
  find: { schema: z.object({ path: z.string().describe("Directory to search"), term: z.string().describe("Filename substring") }) },
}

export const toolSchemas: Record<string, z.ZodObject<z.ZodRawShape>> = Object.fromEntries(
  Object.entries(sharedDefs).map(([k, v]) => [k, v.schema])
)

export const toolDefs: ToolDef[] = [
  {
    name: "read",
    description: "Read file content. Append #L:N to read lines L through N (1-indexed).",
    parameters: [
      { name: "path", type: "string", description: "Absolute or relative file path", required: true },
    ],
    schema: sharedDefs.read.schema,
  },
  {
    name: "write",
    description: "Write content to a file (overwrites existing).",
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "content", type: "string", description: "Full file content", required: true },
    ],
    schema: sharedDefs.write.schema,
  },
  {
    name: "edit",
    description: "Find-and-replace in a file. Replaces FIRST occurrence of text.",
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "find", type: "string", description: "Text to find (exact match)", required: true },
      { name: "replace", type: "string", description: "Replacement text", required: true },
    ],
    schema: sharedDefs.edit.schema,
  },
  {
    name: "ls",
    description: "List directory contents or files recursively.",
    parameters: [
      { name: "path", type: "string", description: "Directory path", required: true },
      { name: "recursive", type: "boolean", description: "If true, walk subdirectories and return file paths (slash-separated)", required: false },
    ],
    schema: sharedDefs.ls.schema,
  },
  {
    name: "mkdir",
    description: "Create directory (recursive, no error if exists).",
    parameters: [
      { name: "path", type: "string", description: "Directory path", required: true },
    ],
    schema: sharedDefs.mkdir.schema,
  },
  {
    name: "grep",
    description: "Recursively search files for a term. Returns matching lines with line numbers.",
    parameters: [
      { name: "path", type: "string", description: "Directory to search", required: true },
      { name: "term", type: "string", description: "Text to search for", required: true },
    ],
    schema: sharedDefs.grep.schema,
  },
  {
    name: "find",
    description: "Recursively find files/directories matching a term in their name.",
    parameters: [
      { name: "path", type: "string", description: "Directory to search", required: true },
      { name: "term", type: "string", description: "Filename substring to match", required: true },
    ],
    schema: sharedDefs.find.schema,
  },
]

export const toolHandlers: Record<string, ToolHandler> = {
  read: (args) => file_read({ path: args.path as string }),
  write: (args) => file_write({ path: args.path as string, content: args.content as string }),
  edit: (args) => file_edit({ path: args.path as string, find: args.find as string, replace: args.replace as string }),
  ls: (args) => lsTool({ path: args.path as string, recursive: args.recursive as boolean | undefined }),
  mkdir: (args) => mkdirTool({ path: args.path as string }),
  grep: (args) => grepTool({ path: args.path as string, term: args.term as string }),
  find: (args) => findTool({ path: args.path as string, term: args.term as string }),
}

const EOT = "\x03"

function paramGbnfRule(p: ToolParam): string {
  if (p.enum) return `(${p.enum.map((v) => `"\\"${v}\\""`).join(" | ")})`
  switch (p.type) {
    case "number": return "number-value"
    case "boolean": return "boolean-value"
    case "string":
      return p.name === "content" || p.name === "replace" ? "prose-string" : "string-value"
  }
}

function gbnfToolCallSection(defs: ToolDef[]): { lines: string[]; callNames: string[] } {
  const lines: string[] = [
    'prose-string ::= "\\"" ([^"\\\\\\n\\r] | "\\\\" .)* "\\""',
    'string-value ::= "\\"" ([^"\\n\\r] | "\\\\" "\\"")* "\\""',
    'number-value ::= [0-9]+ ("." [0-9]+)?',
    'boolean-value ::= "true" | "false"',
  ]
  const callNames: string[] = []
  for (const t of defs) {
    const safe = t.name.replace(/_/g, "")
    const cn = `call${safe}`
    callNames.push(cn)
    lines.push(`${safe}name ::= "\\"name\\"" ws ":" ws "\\"${t.name}\\""`)
    const params = t.parameters.map((p) =>
      `"\\"${p.name}\\"" ws ":" ws ${paramGbnfRule(p)}`
    ).join(` ws "," ws `)
    lines.push(`${safe}args ::= "\\"arguments\\"" ws ":" ws "{" ws ${params} ws "}"`)
    lines.push(`${cn} ::= "\\t" "<tool_call>" "\\n" "\\t" "{" ws ${safe}name ws "," ws ${safe}args ws "}" "\\n" "\\t" "</tool_call>"`)
  }
  return { lines, callNames }
}

function gbnfRoot(defs: ToolDef[], rootRule: string): string {
  const shared = [
    'think-block ::= "\\t" "<think>" "\\n" "\\t" [^<]* "\\n" "\\t" "</think>"',
    'text ::= "\t" [^<]*',
    'ws ::= [ \\t\\n]*',
  ]
  const { lines, callNames } = gbnfToolCallSection(defs)
  return [
    rootRule,
    ...shared,
    ...lines,
    `call ::= ${callNames.join(" | ")}`,
  ].join("\n")
}

export function toolsToGbnf(defs?: ToolDef[]): string {
  return gbnfRoot(defs ?? toolDefs, "root ::= call")
}

export function toolsToGbnfWithThink(defs?: ToolDef[]): string {
  const S = "\x00"
  return gbnfRoot(defs ?? toolDefs, `root ::= ws? (think-block | text | call ws?)*`)
}

export function toolsToGbnfText(defs?: ToolDef[]): string {
  return gbnfRoot(defs ?? toolDefs, "root ::= (think-block? ws)? (text | call)")
}

/** Zod‑based GBNF generation — uses schema field when available */
export function toolsToGbnfZod(defs?: ToolDef[]): string {
  const tds = defs ?? toolDefs
  const schemas: Record<string, z.ZodObject<z.ZodRawShape>> = {}
  for (const t of tds) {
    if (t.schema) schemas[t.name] = t.schema
  }
  return buildRootGrammar(schemas)
}

export function toolsToGbnfResponse(): string {
  return [
    `root ::= text "\\n\\n" "${EOT}"`,
    `text ::= [^${EOT}]*`,
  ].join("\n")
}

export function toolsToXml(defs?: ToolDef[]): string {
  return (defs ?? toolDefs).map((t) => {
    const params = t.parameters.map((p) =>
      `  <parameter name="${p.name}" type="${p.type}"${p.required ? " required=\"true\"" : ""}>${p.description}</parameter>`
    ).join("\n")
    return `<tool name="${t.name}" description="${t.description}">\n${params}\n</tool>`
  }).join("\n\n")
}
