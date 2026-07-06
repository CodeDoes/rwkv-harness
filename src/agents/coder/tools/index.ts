import { ToolDef, ToolHandler } from "../../../types.ts"
import file_read from "../../../tools/read.ts"
import file_write from "../../../tools/write.ts"
import file_edit from "../../../tools/edit.ts"
import lsTool from "../../../tools/ls.ts"
import mkdirTool from "../../../tools/mkdir.ts"
import grepTool from "../../../tools/grep.ts"
import findTool from "../../../tools/find.ts"
import bashTool from "../../../tools/bash.ts"

export const toolDefs: ToolDef[] = [
  {
    name: "read",
    description: "Read file content. Append #L:N to read lines L through N (1-indexed).",
    parameters: [
      { name: "path", type: "string", description: "Absolute or relative file path", required: true },
    ],
  },
  {
    name: "write",
    description: "Write content to a file (overwrites existing).",
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "content", type: "string", description: "Full file content", required: true },
    ],
  },
  {
    name: "edit",
    description: "Find-and-replace in a file. Replaces FIRST occurrence of text.",
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "find", type: "string", description: "Text to find (exact match)", required: true },
      { name: "replace", type: "string", description: "Replacement text", required: true },
    ],
  },
  {
    name: "ls",
    description: "List directory contents.",
    parameters: [
      { name: "path", type: "string", description: "Directory path", required: true },
    ],
  },
  {
    name: "mkdir",
    description: "Create directory (recursive, no error if exists).",
    parameters: [
      { name: "path", type: "string", description: "Directory path", required: true },
    ],
  },
  {
    name: "grep",
    description: "Recursively search files for a term. Returns matching lines with line numbers.",
    parameters: [
      { name: "path", type: "string", description: "Directory to search", required: true },
      { name: "term", type: "string", description: "Text to search for", required: true },
    ],
  },
  {
    name: "find",
    description: "Recursively find files/directories matching a term in their name.",
    parameters: [
      { name: "path", type: "string", description: "Directory to search", required: true },
      { name: "term", type: "string", description: "Filename substring to match", required: true },
    ],
  },
  {
    name: "bash",
    description:
      "Run a shell command (non‑interactive). Useful for type checks, linters, formatting, etc. Output is truncated to ~8 kB.",
    parameters: [
      { name: "command", type: "string", description: "Shell command", required: true },
    ],
  },
]

export const toolHandlers: Record<string, ToolHandler> = {
  read: (args) => file_read({ path: args.path as string }),
  write: (args) => file_write({ path: args.path as string, content: args.content as string }),
  edit: (args) => file_edit({ path: args.path as string, find: args.find as string, replace: args.replace as string }),
  ls: (args) => lsTool({ path: args.path as string }),
  mkdir: (args) => mkdirTool({ path: args.path as string }),
  grep: (args) => grepTool({ path: args.path as string, term: args.term as string }),
  find: (args) => findTool({ path: args.path as string, term: args.term as string }),
  bash: (args) => bashTool({ command: args.command as string }),
}

export function toolsToXml(): string {
  return toolDefs.map((t) => {
    const params = t.parameters.map((p) =>
      `  <parameter name="${p.name}" type="${p.type}"${p.required ? " required=\"true\"" : ""}>${p.description}</parameter>`
    ).join("\n")
    return `<tool name="${t.name}" description="${t.description}">\n${params}\n</tool>`
  }).join("\n\n")
}
