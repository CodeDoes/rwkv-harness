#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { TraceWriter } from "./trace-writer.ts"
import { AgentLoop } from "../agents/loop.ts"
import { SessionManager } from "../session/session.ts"
import { MockModel } from "./mock-engine.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
  tw.write("system", "hi")
  tw.write("user", "hello")
  tw.write("assistant", "Sure thing!")
  tw.write("user", "again?")
  tw.write("assistant", "Yep.")
  tw.close()

  const text = readTrace(tw.path)

  check("starts with meta:", text.startsWith("meta: "))
  check("contains # label: fixture", text.includes("# label: fixture"))
  check("contains system: header with body \\thi", /\nsystem:\n\thi\b/.test(text))
  check("contains user: header with body \\thello", /\nuser:\n\thello\b/.test(text))
  check("contains assistant: header with body \\tSure thing!", /\nassistant:\n\tSure thing!/.test(text))
  check("contains user: header with body \\tagain?", /\nuser:\n\tagain\?/.test(text))
  check("contains assistant: header with body \\tYep.", /\nassistant:\n\tYep\./.test(text))
  check("ends with end: line", text.trimEnd().split("\n").pop()?.startsWith("end:") ?? false)
  check("no --- markers in body", countMatches(text, /^--- /gm) === 0)
  check("no '--- input ---' legacy marker", !text.includes("--- input ---"))
  check("no '--- output ---' legacy marker", !text.includes("--- output ---"))
  check("no '--- tool-result ---' legacy marker", !text.includes("--- tool-result ---"))
}

async function traceShapeAgentLoopTest() {
  console.log("\n── 2. AgentLoop → TraceWriter (agent-level user/assistant) ──")

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

  tw.write("user", "hi there")
  await loop.run("hi there", {
    onRawOutput: (r) => tw.write("assistant", r),
    onText: () => {},
  })

  tw.close()
  const text = readTrace(tw.path)

  check("output 'Hello, friend!' present", text.includes("Hello, friend!"))
  check("output 'How can I help?' present", text.includes("How can I help?"))
  check("no --- markers", countMatches(text, /^--- /gm) === 0)
  check("no '<|endoftext|>' literal", !text.includes("<|endoftext|>"))
}

async function writeRoleInterleavingTest() {
  console.log("\n── 3. write() role interleaving ordering ──")

  const tw = new TraceWriter("ordering")
  tw.open({ mode: "ordering" })

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "ord-sess-"))
  const session = new SessionManager(path.dirname(sessionDir), path.basename(sessionDir), "ord")
  await session.ensureDir()

  const order: string[] = []

  const model = new MockModel([
    `<tool_call>\n{"name":"read","arguments":{"path":"x"}}\n</tool_call>`,
    `All done.`,
  ])

  const loop = new AgentLoop(model, session, 5)

  tw.write("user", "test")
  await loop.run("test", {
    onRawOutput: (raw) => {
      order.push(`output(${raw.length})`)
      tw.write("assistant", raw)
    },
    onText: () => {},
  })

  tw.close()
  const text = readTrace(tw.path)

  check("user: header written", /\nuser:\n\ttest\b/.test(text))
  check("assistant headers >= 2", countMatches(text, /^assistant:$/gm) >= 2)
  check("onRawOutput fired once per round (>=2)", order.length >= 2)
  check("no --- markers", countMatches(text, /^--- /gm) === 0)
}

async function main() {
  console.log("Trace shape tests")
  await traceShapeHandTest()
  await traceShapeAgentLoopTest()
  await writeRoleInterleavingTest()

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
