import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

/// ── Entry type (semantic, no tags in content) ──

export type ExampleType = "system" | "user" | "think" | "tool_call" | "tool_response" | "text"

export interface ExampleEntry {
  type: ExampleType
  content: string
}

/// ── Template system ──

export type ExampleFormatter = (entries: ExampleEntry[]) => string

const templates = new Map<string, ExampleFormatter>()

export function registerTemplate(name: string, fmt: ExampleFormatter): void {
  templates.set(name, fmt)
}

export function getTemplate(name: string): ExampleFormatter {
  const t = templates.get(name)
  if (!t) throw new Error(`Unknown example template "${name}". Available: ${[...templates.keys()].join(", ")}`)
  return t
}

/// ── Default template ──

registerTemplate("default", (entries) => {
  const segments: string[] = []
  let i = 0
  while (i < entries.length) {
    const e = entries[i]
    if (e.type === "user") {
      segments.push(`User: ${e.content}`)
      i++
    } else if (e.type === "tool_response") {
      segments.push(`User:\n<tool_response>\n${e.content}\n</tool_response>`)
      i++
    } else {
      // Group consecutive think/tool_call/text into one assistant turn
      let assistantText = ""
      let first = true
      while (i < entries.length && !["user", "tool_response"].includes(entries[i].type)) {
        const cur = entries[i]
        const sep = first ? "" : "\n"
        switch (cur.type) {
          case "think":
            assistantText += `${sep}<think>${cur.content}</think>`
            break
          case "tool_call":
            assistantText += `${sep}<tool_call>\n${cur.content}\n</tool_call>`
            break
          case "text":
            assistantText += `${sep}${cur.content}`
            break
        }
        first = false
        i++
      }
      segments.push(`Assistant: ${assistantText}`)
    }
  }
  return segments.join("\n\n")
})

/// ── No-think template (strips think blocks) ──

registerTemplate("no-think", (entries) => {
  const filtered = entries.filter(e => e.type !== "think")
  return getTemplate("default")(filtered)
})

/// ── Render a single assistant turn (for mock responses) ──
/// Produces content without "Assistant:" prefix.
/// Filters to think/tool_call/text entries only.

export function renderAssistantTurn(entries: ExampleEntry[], templateName = "default"): string {
  const filtered = entries.filter(e => e.type === "think" || e.type === "tool_call" || e.type === "text")
  const rendered = getTemplate(templateName)(filtered)
  // Remove the leading "Assistant: " prefix added by the conversation template
  return rendered.replace(/^Assistant:\s*/, "")
}

/// ── Loading ──

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.resolve(__dirname, ".")

export function loadExampleEntries(agentName: string): ExampleEntry[] {
  const examplesDir = path.join(AGENTS_DIR, agentName, "examples")
  const entries: ExampleEntry[] = []
  try {
    const files = fs.readdirSync(examplesDir).filter(f => f.endsWith(".jsonl")).sort()
    for (const file of files) {
      const lines = fs.readFileSync(path.join(examplesDir, file), "utf-8").trim().split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const entry: ExampleEntry = JSON.parse(trimmed)
        entries.push(entry)
      }
    }
  } catch {}
  return entries
}

export function renderExamples(agentName: string, templateName = "default"): string {
  const entries = loadExampleEntries(agentName)
  if (entries.length === 0) return ""
  const fmt = getTemplate(templateName)
  const rendered = fmt(entries)
  return `\n\nExamples:\n\n${rendered}`
}

/// ── Default examples (inline fallback) ──

export function loadDefaultExampleEntries(): ExampleEntry[] {
  const filePath = path.join(AGENTS_DIR, "default", "examples.jsonl")
  try {
    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n")
    return lines.filter(l => l.trim()).map(l => JSON.parse(l.trim()) as ExampleEntry)
  } catch {
    return []
  }
}

export function renderDefaultExamples(templateName = "default"): string {
  const entries = loadDefaultExampleEntries()
  if (entries.length === 0) return ""
  const fmt = getTemplate(templateName)
  return fmt(entries)
}
