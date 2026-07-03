import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import type { ToolResult } from "../types.ts"

/// ── Entry type (semantic, no tags in content) ──

export type ExampleType = "system" | "user" | "think" | "tool_call" | "tool_response" | "text"

export interface ExampleEntry {
  type: ExampleType
  content: string
}

/// ── Template: an object with individual format methods ──

export interface ExampleFormatter {
  /** Render full conversation from entries. */
  format(entries: ExampleEntry[]): string
  /** Render a tool result block (XML payload only). */
  formatToolResponse(result: ToolResult): string
  /** Render user text input with role prefix. */
  formatUserInput(input: string): string
  /** Role marker for the assistant turn (no separator). e.g. "Assistant:" */
  formatAssistantRole(): string
  /** Role marker before tool response block. e.g. "User:\n" */
  formatToolResponseRole(): string
}

const templates = new Map<string, ExampleFormatter>()

export function registerTemplate(name: string, fmt: ExampleFormatter): void {
  templates.set(name, fmt)
}

export function getTemplate(name: string): ExampleFormatter {
  const t = templates.get(name)
  if (!t) throw new Error(`Unknown example template "${name}". Available: ${[...templates.keys()].join(", ")}`)
  return t
}

function indentContent(content: string): string {
  return content.replace(/\n/g, "\n\t")
}

/// ── Default template ──

registerTemplate("default", {
  format(entries) {
    const segments: string[] = []
    let i = 0
    while (i < entries.length) {
      const e = entries[i]
      if (e.type === "user") {
        segments.push(`User: ${e.content}`)
        i++
      } else if (e.type === "tool_response") {
        segments.push(`User:\n<tool_response>\n\t${indentContent(e.content)}\n</tool_response>`)
        i++
      } else {
        let assistantText = ""
        let first = true
        while (i < entries.length && !["user", "tool_response"].includes(entries[i].type)) {
          const cur = entries[i]
          const sep = first ? "" : "\n"
          switch (cur.type) {
            case "think":
              assistantText += `${sep}<think>\n\t${indentContent(cur.content)}\n</think>`
              break
            case "tool_call":
              assistantText += `${sep}<tool_call>\n\t${indentContent(cur.content)}\n</tool_call>`
              break
            case "text":
              assistantText += `${sep}\t${indentContent(cur.content)}`
              break
          }
          first = false
          i++
        }
        segments.push(`Assistant:\n${assistantText}`)
      }
    }
    return segments.join("\n\n")
  },

  formatToolResponse(result) {
    const payload = result.success && !result.error
      ? { name: result.name, result: result.data ?? { success: true } }
      : { name: result.name, result: { success: false, error: result.error } }
    const body = JSON.stringify(payload)
    const truncated = body.length > 2000 ? body.slice(0, 2000) + "..." : body
    return `<tool_response>\n\t${truncated}\n</tool_response>`
  },

  formatUserInput(input) {
    return `User: ${input}`
  },

  formatAssistantRole() {
    return "Assistant:"
  },

  formatToolResponseRole() {
    return "User:\n"
  },
})

/// ── No-think template ──

registerTemplate("no-think", {
  format(entries) {
    const filtered = entries.filter(e => e.type !== "think")
    return getTemplate("default").format(filtered)
  },
  formatToolResponse: getTemplate("default").formatToolResponse,
  formatUserInput: getTemplate("default").formatUserInput,
  formatAssistantRole: getTemplate("default").formatAssistantRole,
  formatToolResponseRole: getTemplate("default").formatToolResponseRole,
})

/// ── Render a single assistant turn (for mock responses) ──

export function renderAssistantTurn(entries: ExampleEntry[], templateName = "default"): string {
  const filtered = entries.filter(e => e.type === "think" || e.type === "tool_call" || e.type === "text")
  const rendered = getTemplate(templateName).format(filtered)
  return rendered.replace(/^Assistant:\s*/, "")
}

/// ── Loading ──

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.resolve(__dirname, ".")

function resolveAtPaths(value: unknown, baseDir: string): unknown {
  if (typeof value === "string") {
    if (value.startsWith("@")) {
      const refPath = path.resolve(baseDir, value.slice(1))
      try {
        return fs.readFileSync(refPath, "utf-8")
      } catch {
        throw new Error(`@ref not found: ${refPath}`)
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map(v => resolveAtPaths(v, baseDir))
  if (value && typeof value === "object") {
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = resolveAtPaths(v, baseDir)
    }
    return obj
  }
  return value
}

function resolveEntry(entry: ExampleEntry, baseDir: string): ExampleEntry {
  const content = entry.content
  if (content.startsWith("{")) {
    const parsed = JSON.parse(content)
    const resolved = resolveAtPaths(parsed, baseDir)
    return { ...entry, content: JSON.stringify(resolved) }
  }
  return { ...entry, content: resolveAtPaths(content, baseDir) as string }
}

function loadExampleSequences(agentName: string): ExampleEntry[][] {
  const examplesDir = path.join(AGENTS_DIR, agentName, "examples")

  // 1. Try a TypeScript loader module (e.g. examples.ts exporting
  //    loadStorytellerExamples()). resolved synchronously via createRequire.
  try {
    const tsLoader = path.join(examplesDir, "examples.ts")
    if (fs.existsSync(tsLoader)) {
      const _require = createRequire(import.meta.url)
      const mod = _require(tsLoader) as Record<string, unknown>
      const loaderName = Object.keys(mod).find(k =>
        /^load.*Examples$/.test(k)
      )
      if (loaderName && typeof mod[loaderName] === "function") {
        const result = (mod[loaderName] as CallableFunction)()
        // Support both single array (legacy) and array of arrays (multi-sequence)
        if (Array.isArray(result)) {
          if (result.length > 0 && Array.isArray(result[0])) {
            return (result as ExampleEntry[][])
          }
          return [result as ExampleEntry[]]
        }
      }
    }
  } catch {
    // No TS loader found or failed; fall through to .jsonl search
  }

  // 2. Fall back to individual .jsonl files (legacy mode, still used by
  //    other agents such as the envoy). Each .jsonl file is one sequence.
  const sequences: ExampleEntry[][] = []
  try {
    const files = fs.readdirSync(examplesDir).filter(f => f.endsWith(".jsonl")).sort()
    for (const file of files) {
      const filePath = path.join(examplesDir, file)
      const baseDir = path.dirname(filePath)
      const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n")
      const seq: ExampleEntry[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const entry: ExampleEntry = JSON.parse(trimmed)
        seq.push(resolveEntry(entry, baseDir))
      }
      sequences.push(seq)
    }
  } catch {}
  return sequences
}

export function loadExampleEntries(agentName: string): ExampleEntry[] {
  return loadExampleSequences(agentName).flat()
}

export function renderExamples(agentName: string, templateName = "default"): string {
  const sequences = loadExampleSequences(agentName)
  if (sequences.length === 0) return ""
  const fmt = getTemplate(templateName)
  if (sequences.length === 1) {
    const rendered = fmt.format(sequences[0])
    return `\n\nExamples:\n\n${rendered}`
  }
  const rendered = sequences.map((seq, i) =>
    `Example ${i + 1}:\n\n${fmt.format(seq)}`
  ).join("\n\n")
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
  return fmt.format(entries)
}
