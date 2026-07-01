import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.resolve(__dirname, "..", "agents")

const DIRS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
const CHARS = ["Kael", "Lyra", "Thorn", "Nyx", "Vale", "Orin"]

interface ExampleEntry {
  type: "system" | "user" | "text" | "tool_call" | "tool_result"
  content: string
}

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]
}

function fillPlaceholders(text: string, dir: string, char: string): string {
  return text.replace(/\{\{dir\}\}/g, dir).replace(/\{\{char\}\}/g, char)
}

function formatEntry(entry: ExampleEntry, dir: string, char: string): string {
  const content = fillPlaceholders(entry.content, dir, char)
  switch (entry.type) {
    case "system":
      return `System:\n${content}`
    case "user":
      return `User:\n${content}`
    case "text":
      return `Assistant:\n${content}`
    case "tool_call":
      return `Assistant:\n<tool_call>\n${content}\n</tool_call>`
    case "tool_result":
      return `User:\n<tool_result>\n${content}\n</tool_result>`
  }
}

export function loadExamples(agentName: string): string {
  const examplesDir = path.join(AGENTS_DIR, agentName, "examples")
  const parts: string[] = []

  try {
    const files = fs.readdirSync(examplesDir).filter(f => f.endsWith(".jsonl")).sort()
    for (let fi = 0; fi < files.length; fi++) {
      const content = fs.readFileSync(path.join(examplesDir, files[fi]), "utf-8")
      const lines = content.trim().split("\n").filter(l => l.trim())
      const dir = pick(DIRS, fi)
      const char = pick(CHARS, fi * 2 + 1)
      const turns = lines.map(line => formatEntry(JSON.parse(line) as ExampleEntry, dir, char))
      parts.push(turns.join("\n\n"))
    }
  } catch { }

  return parts.length ? "\n\nExamples:\n\n" + parts.join("\n\n") : ""
}
