#!/usr/bin/env node
import { Agent, exampleEntryToMessagePart } from "./agent.ts"
import { Tool } from "../tools/tool.ts"
import { z } from "zod"

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) pass++; else fail++
  console.log(`  ${cond ? "[PASS]" : "[FAIL]"} ${name}`)
}

// ── Agent construction ──

const readTool = new Tool({
  name: "read",
  description: "Read file",
  input_schema: z.object({ path: z.string() }),
  exec: ({ path }) => `read ${path}`,
})

const writeTool = new Tool({
  name: "write",
  description: "Write file",
  input_schema: z.object({ path: z.string(), content: z.string() }),
  exec: ({ path, content: _c }) => `wrote ${path}`,
})

const agent = new Agent({
  name: "test-agent",
  tools: { read: readTool, write: writeTool },
  instructions: "You can read and write files.",
})

check("agent name", agent.name === "test-agent")
check("agent tools count", Object.keys(agent.tools).length === 2)
check("agent instructions", agent.instructions.includes("read and write"))
check("agent tools[name] access", agent.tools.read.name === "read")

// ── Legacy handlers bridge ──

const handlers = agent.legacyHandlers
check("legacy handlers has read", typeof handlers.read === "function")
check("legacy handlers has write", typeof handlers.write === "function")

// ── getStateTuneExamples lazy-loads ──

const examples = await agent.getStateTuneExamples()
// test-agent has no examples dir, so should be empty
check("lazy examples empty for test agent", examples.length === 0)

// ── Cache ──

const examples2 = await agent.getStateTuneExamples()
check("examples are cached (same ref)", examples === examples2)
agent.clearExampleCache()
const examples3 = await agent.getStateTuneExamples()
check("examples reloaded after cache clear", examples3 !== examples2)

// ── Agent with envoy examples ──

const envoy = new Agent({
  name: "envoy",
  tools: {},
  instructions: "You are the envoy.",
})
const envoyExamples = await envoy.getStateTuneExamples()
check("envoy examples load from disk", envoyExamples.length > 0)
// First example should be a user message (the actual user input)
check("envoy example[0] is a MessagePart", "type" in envoyExamples[0] && "content" in envoyExamples[0])

// ── Summary ──

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
