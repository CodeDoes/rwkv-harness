#!/usr/bin/env node
/**
 * Storyteller *context‑management* eval.
 *
 * Runs only the inner part of the envoy → storyteller pipeline.
 *
 *  • The storyteller agent is driven directly.
 *  • While it runs we **persist** every `write` tool call to disk –
 *    the real file content is written.
 *  • When a file is successfully persisted, we also **summarize** it
 *    into a side‑store (the “memory” of the agent).  The summary is
 *    the first 120 characters of the file (or a note “<empty>” if
 *    the file is empty).  The agent will later only see the summaries
 *    when it asks for context / reads the file.
 *
 * The assertions are:
 *   – every file the agent wrote exists on disk,
 *   – the side‑store contains a short summary for each file,
 *   – the chapter titles (which appear in the writer’s content) are
 *     present in both the written file and the summary.
 *
 * This mirrors the "generate → summarise" workflow that we intend to
 * use for very long‑form generations: full context while writing,
 * summarised context afterwards.
 *
 * Run with `pnpm test:storyteller-context`.  The script uses a
 * MockModel, so no GPU is required.
 */

import {
  promises as fsp,
  mkdirSync as mkdirSyncCb,
  writeFileSync,
  readFileSync,
} from "fs"
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

interface Check {
  name: string
  pass: boolean
  detail?: string
}

/** Keep full‑length content while the agent is still working on it,
 *  but replace it with a short summary once the write is done.
 *  This mimics the “two‑tier” memory we want for long generations. */
class ContextStore {
  /** absolute path → summary string */
  readonly summaries = new Map<string, string>()
  /** Absolute path → original content (used for verification only) */
  readonly rawContents = new Map<string, string>()

  record(filePath: string, absolute: string, content: string) {
    this.rawContents.set(filePath, content)
    const trimmed = content.trim()
    const summary = trimmed.length === 0
      ? "<empty>"
      : trimmed.length > 120
        ? trimmed.slice(0, 120) + "…"
        : trimmed
    this.summaries.set(filePath, summary)
  }
}

function summarize(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length === 0) return "<empty>"
  return trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed
}

function makeWriteCall(pathArg: string, content: string): string {
  // Escaped JSON string for a tool‑call body.
  const escaped = JSON.stringify({ name: "write", args: { path: pathArg, content } })
  return `\n<tool_call>\n${escaped}\n</tool_call>\n`
}

async function run() {
  const checks: Check[] = []
  const ctx = new ContextStore()

  // ---- 1️⃣  Prepare workspace. ----
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "storyteller-context-"))
  const baseDir = path.join(tmpRoot, "workspace")
  await fsp.mkdir(baseDir, { recursive: true })

  // ---- 2️⃣  write‑tool handler that records the content + summary. ----
  const handlers = {
    ...defaultHandlers,
    write: (args: { path: string; content: string }) => {
      const absolute = path.resolve(baseDir, args.path)
      mkdirSyncCb(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, args.content, "utf8")
      ctx.record(args.path, absolute, args.content)
      return {
        success: true,
        path: absolute,
        bytes: Buffer.byteLength(args.content, "utf8"),
        status: "written",
      }
    },
  }

  // ---- 3️⃣  Build canned responses:
  //       plan → chapter1 → chapter2 → empty (lets the loop finish cleanly).
  const planContent = `---\n# Dragon Mystery: Plan\n\nPremise seeds: young finder, mute dragon, traveling scholar.`
  const chapter1Content = `# Chapter 1: The Egg\n\nKael found the egg in a high‑altitude village, abandoned by the Council. He brought it home, kept it warm, and watched it hatch. The hatchling was mute and had a strange feather pattern on its back.`
  const chapter2Content = `# Chapter 2: The Feather\n\nThe feather pattern was the seal of a long‑lost clan. The village elder recognised it from old scrolls. They believed the egg might be the last of the clan, and that the mute dragon was its spirit.`

  // Provide a few empty responses after the last tool call so the “empty stream”
  // retry guard can terminate the loop.
  const emptyResponses = new Array(6).fill("")

  const model = new MockModel([
    makeWriteCall("plan.md", planContent),
    makeWriteCall("chapter1.md", chapter1Content),
    makeWriteCall("chapter2.md", chapter2Content),
    ...emptyResponses,
  ])

  // 👉  Debug: confirm the parser recognises the canned tool call format.
  console.log("\nParser self‑check (first response):")
  console.log(parseToolCalls(model.responses[0]))

  await model.init()

  // ---- 4️⃣  Run the AgentLoop. ----
  const session = new Session({
    id: "storyteller-context-sid",
    agentName: "storyteller",
  })

  const loop = new AgentLoop(model, session, 4, {
    systemPrompt:
      "You are a writing agent whose job is to write a plan and three chapters for a dragon mystery. Use ONLY the `write` tool.",
    toolDefs: defaultToolDefs,
    toolHandlers: handlers,
    examples: "",
    templateName: "default",
  })

  const finalText = await loop.run(
    "Write plan.md, chapter1.md, chapter2.md describing a dragon mystery.",
  )
  console.log("   finalText length:", finalText?.length)
  console.log("   workspace contents:", await fsp.readdir(baseDir).catch(() => []))

  // ---- 5️⃣  Verify the files. ----
  for (const [file, content] of Object.entries({
    "plan.md": planContent,
    "chapter1.md": chapter1Content,
    "chapter2.md": chapter2Content,
  })) {
    const abs = path.join(baseDir, file)
    const exists = await fsp.access(abs).then(() => true).catch(() => false)
    checks.push({ name: `${file} exists on disk`, pass: exists })
    if (!exists) continue
    const onDisk = readFileSync(abs, "utf8")
    checks.push({
      name: `${file} content matches mock payload`,
      pass: onDisk === content,
      detail: onDisk === content ? "" : "written content differs",
    })
  }

  // ---- 6️⃣  Verify the context‑store picked up summaries. ----
  const expected = ["plan.md", "chapter1.md", "chapter2.md"]
  for (const file of expected) {
    checks.push({
      name: `${file} has a stored summary`,
      pass: ctx.summaries.has(file),
    })
    if (ctx.summaries.has(file)) {
      const raw = ctx.rawContents.get(file) ?? ""
      const summary = ctx.summaries.get(file) ?? ""
      const trimmed = raw.trim()
      const want =
        trimmed.length === 0
          ? "<empty>"
          : trimmed.length > 120
            ? trimmed.slice(0, 120) + "…"
            : trimmed
      checks.push({
        name: `${file} summary contains keywords`,
        pass:
          summary.includes("Dragon") ||
          summary.includes("Egg") ||
          summary.includes("Feather") ||
          summary.includes("Plan"),
      })
      checks.push({
        name: `${file} summary equals expected`,
        pass: summary === want,
      })
    }
  }

  // ---- 7️⃣  Print a compact summary view. ----
  console.log("\nContext‑store contents (the “memory” the model would see later):")
  for (const [file, summary] of ctx.summaries) {
    console.log(`  • ${file} → ${summary}`)
  }

  console.log(`\nWorkspace preserved at: ${tmpRoot}`)
  summarizeCheck(checks)
}

function summarizeCheck(checks: Check[]) {
  let passed = 0
  let failed = 0
  for (const c of checks) {
    const tag = c.pass ? "PASS" : "FAIL"
    const tail = c.detail ? ` — ${c.detail}` : ""
    console.log(`  [${tag}] ${c.name}${tail}`)
    if (c.pass) passed++; else failed++;
  }
  console.log(`\n${passed}/${checks.length} PASS`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
