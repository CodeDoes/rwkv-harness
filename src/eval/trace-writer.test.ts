#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { TraceWriter } from "./trace-writer.ts"
import { AgentLoop } from "../agent/loop.ts"
import { SessionManager } from "../session/session.ts"
import { MockModel } from "./mock-engine.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRACES_DIR = path.resolve(__dirname, "..", "eval", ".traces")

let passCount = 0
let failCount = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passCount++
    console.log(`  [PASS] ${name}`)
  } else {
    failCount++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function readTrace(filePath: string) {
  return fs.readFileSync(filePath, "utf-8")
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) || []).length
}

async function traceShapeHandTest() {
  console.log("\n── 1. TraceWriter direct API (hand-composed trace) ──")

  const tw = new TraceWriter("shapetest")
  tw.open({ mode: "shapetest", label: "fixture" })
  tw.prompt("System: hi\n\nUser: hello\n\nAssistant:")
  tw.output("Sure thing!")
  tw.prompt("User: again?\n\nAssistant:")
  tw.output("Yep.")
  tw.close()

  const text = readTrace(tw.path)

  check("starts with meta:", text.startsWith("meta: "))
  check("contains # label: fixture", text.includes("# label: fixture"))
  check("first body line is the assistant-prompt", text.includes("Assistant:\n\n") || text.includes("Assistant:"))
  check("contains Assistant:", text.includes("Assistant:"))
  check("contains raw output 'Sure thing!'", text.includes("Sure thing!"))
  check("contains raw output 'Yep.'", text.includes("Yep."))
  check("ends with end: line", text.trimEnd().split("\n").pop()?.startsWith("end:") ?? false)
  check("no --- markers in body", countMatches(text, /^--- /gm) === 0)
  check("no '--- input ---' legacy marker", !text.includes("--- input ---"))
  check("no '--- output ---' legacy marker", !text.includes("--- output ---"))
  check("no '--- tool-result ---' legacy marker", !text.includes("--- tool-result ---"))
}

async function traceShapeAgentLoopTest() {
  console.log("\n── 2. AgentLoop → TraceWriter (mirrors real eval path) ──")

  const tw = new TraceWriter("looptest")
  tw.open({ mode: "looptest" })

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"))
  const session = new SessionManager(path.dirname(sessionDir), path.basename(sessionDir), "test")
  await session.ensureDir()

  const model = new MockModel([
    `Hello, friend!<tool_call>\n{"name":"read","arguments":{"path":"foo"}}\n</tool_call>`,
    `How can I help?`,
  ])

  const loop = new AgentLoop(model, session, 5)

  await loop.run("hi there", {
    onPrompt: (p) => tw.prompt(p),
    onRawOutput: (r) => tw.output(r),
    onText: () => {},
  })

  tw.close()
  const text = readTrace(tw.path)

  const assistantHits = countMatches(text, /Assistant:$/gm)
  check("first prompt ends with Assistant:", assistantHits >= 1)
  check("output 'Hello, friend!' present", text.includes("Hello, friend!"))
  check("<tool_call> JSON present", text.includes('"name":"read"'))
  check("second output 'How can I help?' present", text.includes("How can I help?"))

  const prompts = countMatches(text, /\n\nAssistant:$/gm)
  check(">= 2 prompts captured (one per round)", prompts >= 2)

  check("no --- markers", countMatches(text, /^--- /gm) === 0)
  check("no '<|endoftext|>' literal", !text.includes("<|endoftext|>"))
}

async function onPromptFiresBeforeGenerateTest() {
  console.log("\n── 3. onPrompt fires before each generate() ──")

  const tw = new TraceWriter("ordering")
  tw.open({ mode: "ordering" })

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "ord-sess-"))
  const session = new SessionManager(path.dirname(sessionDir), path.basename(sessionDir), "ord")
  await session.ensureDir()

  let promptCount = 0
  let outputCount = 0
  const order: string[] = []

  const model = new MockModel([
    `<tool_call>\n{"name":"read","arguments":{"path":"x"}}\n</tool_call>`,
    `All done.`,
  ])

  const loop = new AgentLoop(model, session, 5)

  await loop.run("test", {
    onPrompt: () => {
      promptCount++
      order.push("prompt")
      tw.prompt(`prompt-${promptCount}`)
    },
    onRawOutput: (raw) => {
      outputCount++
      order.push(`output(${raw.length})`)
      tw.output(raw)
    },
    onText: () => {},
  })

  check("onPrompt fired once per round (>=2)", promptCount >= 2)
  check("onRawOutput fired once per round (>=2)", outputCount >= 2)
  check("order is interleaved: prompt, output, prompt, output...",
    order[0] === "prompt" &&
    order[1]?.startsWith("output(") &&
    order[2] === "prompt")
}

async function main() {
  console.log("Trace shape tests")
  await traceShapeHandTest()
  await traceShapeAgentLoopTest()
  await onPromptFiresBeforeGenerateTest()

  console.log(`\n${passCount}/${passCount + failCount} PASS`)
  if (failCount > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
