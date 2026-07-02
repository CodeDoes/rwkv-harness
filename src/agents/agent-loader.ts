import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { ToolDef, ToolHandler } from "../types.ts"
import { loadExamples } from "./examples.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.resolve(__dirname, ".")

export interface LoadedAgent {
  name: string
  toolDefs: ToolDef[]
  toolHandlers: Record<string, ToolHandler>
  instructions: string
  examples: string
}

export async function loadAgent(agentName: string): Promise<LoadedAgent> {
  const agentDir = path.join(AGENTS_DIR, agentName)

  const instructions = fs.readFileSync(
    path.join(agentDir, "instructions.mdx"),
    "utf-8",
  )

  const toolsModule = await import(path.join(agentDir, "tools", "index.ts")) as {
    toolDefs: ToolDef[]
    toolHandlers: Record<string, ToolHandler>
  }
  const { toolDefs, toolHandlers } = toolsModule

  const examples = loadExamples(agentName)

  return {
    name: agentName,
    toolDefs,
    toolHandlers,
    instructions,
    examples,
  }
}
