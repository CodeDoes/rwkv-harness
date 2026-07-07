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
import bashTool from "./bash.ts"

const sharedDefs = {
  read: { schema: z.object({ path: z.string().describe("File path") }) },
  write: { schema: z.object({ path: z.string().describe("File path"), content: z.string().describe("File content") }) },
  edit: { schema: z.object({ path: z.string().describe("File path"), find: z.string().describe("Text to find"), replace: z.string().describe("Replacement text") }) },
  ls: { schema: z.object({ path: z.string().describe("Directory path"), recursive: z.boolean().optional().describe("If true, walk subdirectories and return file paths") }) },
  mkdir: { schema: z.object({ path: z.string().describe("Directory path") }) },
  grep: { schema: z.object({ path: z.string().describe("Directory to search"), term: z.string().describe("Text to search for") }) },
  find: { schema: z.object({ path: z.string().describe("Directory to search"), term: z.string().describe("Filename substring") }) },
  bash: { schema: z.object({ command: z.string().describe("Shell command (non‑interactive)") }) },
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
  {
    name: "bash",
    description:
      "Run a shell command (non‑interactive) and receive stdout, stderr and the exit status. Useful for `pnpm typecheck`, `node -e`, etc.",
    parameters: [
      { name: "command", type: "string", description: "Shell command to execute", required: true },
    ],
    schema: sharedDefs.bash.schema,
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
  bash: (args) => bashTool({ command: args.command as string }),
}



function paramGbnfRule(p: ToolParam): string {
  if (p.enum) return `enum-value`
  switch (p.type) {
    case "number": return "number-value"
    case "boolean": return "boolean-value"
    case "string":
      return p.name === "content" || p.name === "replace" ? "prose-string" : "string-value"
  }
}

function gbnfToolCallSection(defs: ToolDef[]): { lines: string[]; callNames: string[] } {
  const lines: string[] = [
    'prose-string ::= "\\"" ([^"\\\\n\\r] | "\\\\" .)* "\\""',
    'string-value ::= "\\"" ([^"\\n\\r] | "\\\\" "\\"")* "\\""',
    // Char-class enum/boolean stand-ins (schoolmarm 0.1.1 workaround: its
    // allowed_tokens mask mishandles alternation of multi-char string
    // literals inside complex rules, returning zero valid tokens ->
    // model emits nothing -> silently falls back to free text. Char-class
    // rules mask correctly; invalid enum/boolean members are rejected
    // downstream by the agent loop).
    'enum-value ::= "\\"" [a-z][a-z-]* "\\""',
    'number-value ::= [0-9]+ ("." [0-9]+)?',
    'boolean-value ::= [a-z]+',
  ]
  const callNames: string[] = []
  for (const t of defs) {
    const cn = `call${t.name.replace(/_/g, "")}`
    callNames.push(cn)
    // Build the parameter list once; emit a SINGLE FLAT call rule with
    // everything inlined (no nested rule references). schoolmarm's mask
    // can handle direct string-literal sequences + ws + leaf rules
    // (enum-value/string-value/number-value/boolean-value), but breaks
    // when a rule references another rule that itself references a third.
    const paramStr = t.parameters.map((p) =>
      `"\\"${p.name}\\\"" ws ":" ws ${paramGbnfRule(p)}`
    ).join(` ws "," ws `)
    // The call rule wraps the entire tool-call JSON in a single {"name":..., "arguments":{...}} object.
    // NOTE: the grammar must close BOTH open braces (outer + the arguments inner object). The previous
    // version emitted only one `}` which left the outer object unclosed — every `<tool_call>` then failed
    // `grammarCheck` at the extra `}` the model emitted, and the grammar mask couldn't constrain outputs.
    lines.push(`${cn} ::= "\\t" "<tool_call>" "\\n" "\\t" "{" ws "\\"name\\"" ws ":" ws "\\"${t.name}\\\"" ws "," ws "\\"arguments\\"" ws ":" ws "{" ws ${paramStr} ws "}" ws "}" "\\n" "\\t" "</tool_call>"`)
  }
  return { lines, callNames }
}

function gbnfRoot(defs: ToolDef[], rootRule: string): string {
  const shared = [
    // Every line of free text (outside tags) must be \t-indented:
    //   "tab then alternation of (non-ctrl-non-< char) or (newline+tab)"
    // `<` is excluded so opening tags (<thing>) force a line break if they
    // appear — encouraging tags on their own line (per EXAMPLE.md / user intent).
    'indented-line ::= ([^\\n<] | "\\n\\t")*',
    'think-block ::= "\\t" "<think>" "\\n" "\\t" indented-line "\\n\\t" "</think>"',
    'text ::= "\\t" indented-line',
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
  return gbnfRoot(
    defs ?? toolDefs,
    // After any number of think blocks, require at least one call. Text is
    // only permitted as an OPTIONAL preamble (before the first call) or as
    // trailing/interspersed prose AFTER a call. The grammar structure was
    // empirically tuned + grammarCheck-verified to accept the correct
    // `<tool_call>\n\t{...}` shape — see `registry.ts` call rule fix that
    // closes BOTH `{` opened by the args object.
    `root ::= ws? (think-block)* text? (call (text ws?)*)+`,
  )
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
    `root ::= text "\\n\\n"`,
    `text ::= [^<]*`,
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
