#!/usr/bin/env node
import { Tool } from "./tool.ts"
import { z } from "zod"

let pass = 0
let fail = 0

function check(name: string, cond: boolean) {
  if (cond) pass++; else fail++
  console.log(`  ${cond ? "[PASS]" : "[FAIL]"} ${name}`)
}

// ── Tool from scratch ──

const readTool = new Tool({
  name: "read",
  description: "Read file content",
  input_schema: z.object({ path: z.string() }),
  exec: ({ path }) => `content of ${path}`,
})

check("tool name", readTool.name === "read")
check("tool desc", readTool.description.length > 0)
check("tool grammar non-empty", readTool.grammar().length > 0)
check("tool call rule name", readTool.callRuleName === "callread")

// ── Execution with validation ──

const result = await readTool.exec({ path: "/tmp/x" })
check("exec returns expected", result === "content of /tmp/x")

// ── Execution with bad args (should throw) ──

let threw = false
try { await readTool.exec({ wrong: 1 }) } catch { threw = true }
check("exec throws on invalid args", threw)

// ── Output schema validation ──

const writeTool = new Tool({
  name: "write",
  description: "Write file",
  input_schema: z.object({ path: z.string(), content: z.string() }),
  output_schema: z.object({ success: z.boolean(), path: z.string() }),
  exec: ({ path, content }) => {
    if (path.length < 1) throw new Error("bad path")
    return { success: true, path }
  },
})

const writeResult = await writeTool.exec({ path: "/tmp/a", content: "hi" }) as { success: boolean; path: string }
check("output shape matches schema", typeof writeResult.success === "boolean" && typeof writeResult.path === "string")

// ── Grammar content ──

const grammar = writeTool.grammar()
check("grammar contains tool name", grammar.includes('\\"write\\"'))
check("grammar contains tool_call tags", grammar.includes("<tool_call>"))

// ── Legacy compat ──

const legacyDef = writeTool.toLegacyDef()
check("legacy def name", legacyDef.name === "write")
check("legacy def parameters count", legacyDef.parameters.length === 2)

const fromLegacy = Tool.fromLegacy(legacyDef, ((args: Record<string, unknown>) => `wrote ${args.path}`) as any)
check("fromLegacy name", fromLegacy.name === "write")
const legacyResult = await fromLegacy.exec({ path: "/tmp/x", content: "hi" })
check("fromLegacy exec works", legacyResult === "wrote /tmp/x")

// ── Summary ──

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
