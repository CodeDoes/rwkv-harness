import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.resolve(__dirname, ".")

export function loadExamples(agentName: string): string {
  const examplesDir = path.join(AGENTS_DIR, agentName, "examples")
  const parts: string[] = []

  try {
    const files = fs.readdirSync(examplesDir).filter(f => f.endsWith(".txt")).sort()
    for (const file of files) {
      const content = fs.readFileSync(path.join(examplesDir, file), "utf-8").trim()
      if (content) parts.push(content)
    }
  } catch { }

  return parts.length ? "\n\nExamples:\n\n" + parts.join("\n\n") : ""
}
