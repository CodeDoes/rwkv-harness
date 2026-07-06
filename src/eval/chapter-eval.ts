#!/usr/bin/env node
/**
 * Minimal “write a chapter” eval.
 *
 * Idea:
 *   1. Spin up a `MockModel` that returns a single tool‑call response.
 *   2. Run the real `AgentLoop` against it with the default tools.
 *   3. Verify the `write` tool actually created `chapter1.md` and that
 *      its contents resemble the oracle (Chapter 1: The Egg).
 *
 * The script can be invoked via `pnpm test:chapter`.  It does **not**
 * load the native model; everything is in‑process and finishes in a
 * few seconds.
 *
 * If you ever want to run the same scenario against the real model,
 * replace `MockModel` with a `GatewayControl`‑based engine – the rest
 * of the script stays identical.
 */

import { promises as fsp, mkdirSync, writeFileSync, readFileSync } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import * as os from "os"

import { MockModel } from "./mock-engine.ts"
import {
  toolDefs as defaultToolDefs,
  toolHandlers as defaultHandlers,
} from "../tools/registry.ts"
import { AgentLoop } from "../agents/loop.ts"
import { Session } from "../session/session.ts"
import { parseToolCalls } from "../model/adapter.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORACLE_FILE = path.join(__dirname, "oracle", "chapter1.md")

interface Check {
  name: string
  pass: boolean
  detail?: string
}

/** Crude similarity – word‑level Jaccard after normalisation. */
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const sa = new Set(norm(a).split(" "))
  const sb = new Set(norm(b).split(" "))
  const inter = [...sa].filter((x) => sb.has(x)).length
  const union = new Set([...sa, ...sb]).size
  return union ? inter / union : 0
}

async function runChapterEval() {
  const checks: Check[] = []

  // ---- 1️⃣  Prepare a fresh temporary workspace. ----
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chapter-eval-"))
  const baseDir = path.join(tmpRoot, "workspace")
  await fsp.mkdir(baseDir, { recursive: true })

  // ---- 2️⃣  Wire up a `write` handler that writes into the workspace. ----
  const handlers = {
    ...defaultHandlers,
    write: (args: { path: string; content: string }) => {
      const absolute = path.resolve(baseDir, args.path)
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, args.content, "utf8")
      return {
        success: true,
        path: absolute,
        bytes: Buffer.byteLength(args.content, "utf8"),
        status: "written",
      }
    },
  }

  // ---- 3️⃣  Spin up a mock model that emits a single write call. ----
  const oracleContent = readFileSync(ORACLE_FILE, "utf8").trim()
  const mockToolCall =
    `\n<tool_call>\n{"name":"write","args":{"path":"chapter1.md","content":"` +
    oracleContent.replace(/"/g, '\\"') +
    `"}}\n</tool_call>\n`

  // First response – a tool call. The rest are intentionally empty so the
  // agent‑loop's “empty stream” guard can run out and terminate cleanly.
  const emptyResponses = new Array(10).fill("")
  const model = new MockModel([mockToolCall, ...emptyResponses])

  // 👉  Debug – confirm the parser recognises our mock tool call.
  console.log("\nParser self-check:")
  console.log(parseToolCalls(mockToolCall))

  await model.init()

  // ---- 4️⃣  Build an AgentLoop and run the prompt. ----
  const session = new Session({
    id: "chapter-eval-sid",
    agentName: "chapter-eval",
  })

  const loop = new AgentLoop(model, session, 3, {
    systemPrompt:
      "You are a writing assistant. Use the `write` tool to create exactly one chapter file called `chapter1.md`. Do nothing else.",
    toolDefs: defaultToolDefs,
    toolHandlers: handlers,
    examples: "",
    templateName: "default",
  })

  const finalText = await loop.run("Write a chapter about a dragon.")
  console.log("   finalText length:", finalText?.length)
  console.log("   workspace contents:", await fsp.readdir(baseDir).catch(() => []))

  // ---- 5️⃣  Verify the file was created. ----
  const chapterFile = path.join(baseDir, "chapter1.md")
  const exists = await fsp
    .access(chapterFile)
    .then(() => true)
    .catch(() => false)
  checks.push({ name: "chapter1.md exists on disk", pass: exists })
  if (!exists) return summarize(checks)

  // ---- 6️⃣  Compare to the oracle. ----
  const actual = readFileSync(chapterFile, "utf8")
  const oracle = readFileSync(ORACLE_FILE, "utf8")
  const sim = similarity(actual, oracle)
  checks.push({
    name: "content matches oracle (similarity ≥ 0.5)",
    pass: sim >= 0.5,
    detail: `similarity=${sim.toFixed(2)}`,
  })

  // ---- 7️⃣  Keep the temp dir on success (handy for debugging). ----
  console.log(`  workspace preserved at: ${tmpRoot}`)
  return summarize(checks)
}

function summarize(checks: Check[]): number {
  let failed = 0
  let passed = 0
  for (const c of checks) {
    const tag = c.pass ? "PASS" : "FAIL"
    const tail = c.detail ? ` — ${c.detail}` : ""
    console.log(`  [${tag}] ${c.name}${tail}`)
    if (c.pass) passed++; else failed++;
  }
  console.log(`\n${passed}/${checks.length} PASS`)
  return failed
}

runChapterEval()
  .then((failed) => process.exit(failed === 0 ? 0 : 1))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
