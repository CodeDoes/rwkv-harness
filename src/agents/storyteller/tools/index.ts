import { ToolDef, ToolHandler } from "../../../types.ts"
import file_read from "../../../tools/read.ts"
import file_write from "../../../tools/write.ts"
import lsTool from "../../../tools/ls.ts"
import grepTool from "../../../tools/grep.ts"
import findTool from "../../../tools/find.ts"
import mkdirTool from "../../../tools/mkdir.ts"
import storyAnalyze from "./story-analyze.ts"
import storyValidate from "./story-validate.ts"
import todoTool from "./todo.ts"

export const toolDefs: ToolDef[] = [
  {
    name: "mkdir",
    description: "Create directory (recursive, no error if exists).",
    parameters: [
      { name: "path", type: "string", description: "Directory path", required: true },
    ],
  },
  {
    name: "todo",
    description: "Manage task checklist. Actions: create (with items JSON array), check (mark item done), list (show progress).",
    parameters: [
      { name: "action", type: "string", description: "Action: create, check, or list", required: true, enum: ["create", "check", "list"] },
      { name: "items", type: "string", description: "JSON array of task strings. Required for 'create' action.", required: false },
      { name: "item", type: "string", description: "Task text to mark done. Required for 'check' action.", required: false },
    ],
  },
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
    name: "ls",
    description: "List directory contents.",
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
    name: "story-analyze",
    description: "Analyze story content: word/section/paragraph counts, section structure, author notes, links, possible character names, common typos. Use on chapters, wiki entries, synopses.",
    parameters: [
      { name: "content", type: "string", description: "Text content to analyze", required: true },
    ],
  },
  {
    name: "story-validate",
    description: "Validate story content against rules. Rules: wordCount, paragraphCount, sentenceCount, sectionWordCount, maxParagraphSize, mustInclude, mustNotInclude, mustHaveSection. Each rule has type + params (op, value, words, pattern).",
    parameters: [
      { name: "content", type: "string", description: "Text content to validate", required: true },
      { name: "rules", type: "string", description: "JSON array of validation rules", required: true },
    ],
  },
]

export const toolHandlers: Record<string, ToolHandler> = {
  mkdir: (args) => mkdirTool({ path: args.path as string }),
  todo: (args) => todoTool({ action: args.action as string, item: args.item as string | undefined, items: args.items as string | undefined }),
  read: (args) => file_read({ path: args.path as string }),
  write: (args) => file_write({ path: args.path as string, content: args.content as string }),
  ls: (args) => lsTool({ path: args.path as string }),
  grep: (args) => grepTool({ path: args.path as string, term: args.term as string }),
  find: (args) => findTool({ path: args.path as string, term: args.term as string }),
  "story-analyze": (args) => storyAnalyze({ content: args.content as string }),
  "story-validate": (args) => storyValidate({
    content: args.content as string,
    rules: typeof args.rules === "string" ? JSON.parse(args.rules as string) : args.rules as any[],
  }),
}

export function toolsToXml(): string {
  return toolDefs.map((t) => {
    const params = t.parameters.map((p) =>
      `  <parameter name="${p.name}" type="${p.type}"${p.required ? " required=\"true\"" : ""}>${p.description}</parameter>`
    ).join("\n")
    return `<tool name="${t.name}" description="${t.description}">\n${params}\n</tool>`
  }).join("\n\n")
}
