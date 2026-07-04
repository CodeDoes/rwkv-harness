#!/usr/bin/env node
/**
 * Preview every grammar our tool registry can produce.
 *
 * For each non-empty agent tool set (envoy, storyteller, coder, default)
 * we render four grammar variants:
 *   - tool-only      (`toolsToGbnf`)
 *   - think+text+tool (`toolsToGbnfWithThink`)
 *   - text+tool       (`toolsToGbnfText`)
 *   - zod-driven      (`toolsToGbnfZod`)
 *
 * Plus `toolsToGbnfResponse()` (the simple EOT-terminated response grammar).
 *
 * Output goes to a single `.preview.grammar` file at the repo root,
 * one variant per section, separated by `# ----- ` banners. Sections are
 * labeled by agent + variant. Run with:
 *
 *     pnpm grammar:preview
 *     pnpm grammar:preview --out=path/to/file.grammar
 */
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { ToolDef } from "../src/types.ts"
import {
  toolsToGbnf,
  toolsToGbnfWithThink,
  toolsToGbnfText,
  toolsToGbnfZod,
  toolsToGbnfResponse,
} from "../src/tools/registry.ts"
import { toolDefs as envoyDefs } from "../src/agents/envoy/tools/index.ts"
import { toolDefs as storytellerDefs } from "../src/agents/storyteller/tools/index.ts"
import { toolDefs as coderDefs } from "../src/agents/coder/tools/index.ts"
import { toolDefs as defaultDefs } from "../src/tools/registry.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "..")

interface AgentSpec {
  name: string
  defs: ToolDef[]
}

const AGENTS: AgentSpec[] = [
  { name: "envoy", defs: envoyDefs },
  { name: "storyteller", defs: storytellerDefs },
  { name: "coder", defs: coderDefs },
  { name: "default", defs: defaultDefs },
]

interface Variant {
  label: string
  build: (defs: ToolDef[]) => string
}

const VARIANTS: Variant[] = [
  { label: "tool-only", build: (d) => toolsToGbnf(d) },
  { label: "think+text+tool", build: (d) => toolsToGbnfWithThink(d) },
  { label: "text+tool", build: (d) => toolsToGbnfText(d) },
  { label: "zod", build: (d) => toolsToGbnfZod(d) },
]

function sep(): string {
  return "# " + "-".repeat(78)
}

function render(): string {
  const out: string[] = []
  out.push("# Grammar preview")
  out.push(`# generated: ${new Date().toISOString()}`)
  out.push(`# tool variants: ${VARIANTS.map((v) => v.label).join(", ")}`)
  out.push(`# agents: ${AGENTS.map((a) => a.name).join(", ")}`)
  out.push("")

  for (const agent of AGENTS) {
    for (const variant of VARIANTS) {
      out.push(sep())
      out.push(`# agent: ${agent.name}   variant: ${variant.label}`)
      out.push(sep())
      try {
        const gbnf = variant.build(agent.defs)
        out.push(gbnf)
      } catch (e) {
        out.push(`# ERROR: ${e instanceof Error ? e.message : String(e)}`)
      }
      out.push("")
    }
  }

  out.push(sep())
  out.push("# variant: response-grammar (EOT-terminated plain prose)")
  out.push(sep())
  out.push(toolsToGbnfResponse())
  out.push("")

  return out.join("\n")
}

function parseArgs(argv: string[]): string {
  for (const arg of argv) {
    if (arg.startsWith("--out=")) return arg.slice("--out=".length)
  }
  return path.join(PROJECT_ROOT, ".preview.grammar")
}

function main() {
  const outPath = path.resolve(parseArgs(process.argv.slice(2)))
  const body = render()
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, body, "utf-8")
  const sizes: Array<[string, number]> = []
  for (const line of body.split("\n")) {
    const m = line.match(/^# agent: (\S+)\s+variant:\s+(\S+)/)
    if (!m) continue
    const key = `${m[1]}/${m[2]}`
    sizes.push([key, 0])
  }
  console.log(`preview written: ${outPath}`)
  console.log(`sections:`)
  for (const agent of AGENTS) {
    for (const variant of VARIANTS) {
      console.log(`  - ${agent.name} / ${variant.label}`)
    }
  }
  console.log(`  - response-grammar (EOT-terminated)`)
}

main()
