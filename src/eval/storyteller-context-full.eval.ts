#!/usr/bin/env node
/**
 * Full‑context storyteller eval (plan + 3 chapters + wiki).
 *
 * Runs **only the inner part** of the envoy → storyteller pipeline and
 * implements the “generate → summarise” context‑management we want for
 * long‑form generations:
 *
 *   • The agent writes **seven** files:
 *       plan.md
 *       chapter1.md, chapter2.md, chapter3.md
 *       wiki/character/kael.md
 *       wiki/location/village.md
 *       wiki/item/egg.md
 *
 *   • While it is writing, the full content is stored on disk.
 *   • When a file finishes, a short summary is recorded in a side store
 *     (`ContextStore`).  This is what the model will see later when it
 *     “reads” the file again – the “memory” after writing.
 *
 * The eval asserts:
 *
 *   – every file exists on disk,
 *   – the on‑disk content matches what the canned model emitted,
 *   – the side store contains a summary for each file,
 *   – each summary contains a keyword (Kael/Village/Egg/Dragon …)
 *     so we know it’s not empty.
 *
 * Run with `pnpm test:storyteller-context-full`.
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

interface Check {
  name: string
  pass: boolean
  detail?: string
}

/** Two‑tier memory: full content during writing, summary afterwards. */
class ContextStore {
  readonly summaries = new Map<string, string>()
  readonly rawContents = new Map<string, string>()

  record(filePath: string, absolute: string, content: string) {
    this.rawContents.set(filePath, content)
    const trimmed = content.trim()
    this.summaries.set(
      filePath,
      trimmed.length === 0
        ? "<empty>"
        : trimmed.length > 120
          ? trimmed.slice(0, 120) + "…"
          : trimmed,
    )
  }
}

function makeWriteCall(pathArg: string, content: string): string {
  const escaped = JSON.stringify({
    name: "write",
    args: { path: pathArg, content },
  })
  return `\n<tool_call>\n${escaped}\n</tool_call>\n`
}

async function run() {
  const checks: Check[] = []
  const ctx = new ContextStore()

  // ────── 1️⃣  Prepare the workspace. ──────
  const tmpRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "storyteller-context-full-"),
  )
  const baseDir = path.join(tmpRoot, "workspace")
  await fsp.mkdir(baseDir, { recursive: true })

  // ────── 2️⃣  write‑tool handler that records every file. ──────
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

  // ────── 3️⃣  Canned model responses: 7 writes. ──────
  const plan = `---
# Dragon Mystery: Plan

Premise seeds:

* a young finder who discovers a dragon egg,
* the hatchling dragon who is mute and bears a strange feather,
* a traveling scholar who helps decode ancient texts.

Cast sketch: Kael (the finder), Lyra (the silent dragon), Maren (the village elder), Corin (the scholar).
Setting sketch: a high‑altitude village perched on the rim of the Mountains of Ash.`

const chapter1 = `# Chapter 1: The Egg

Kael found the egg in a high‑altitude village, abandoned by the Council. He brought it home, kept it warm, and watched it hatch. The hatchling was mute and had a strange feather pattern on its back. The villagers called it the “silent one”. The village elder recognised the feather as the seal of a long‑lost clan.`

const chapter2 = `# Chapter 2: The Feather

The feather pattern was the seal of a long‑lost clan. The village elder recognised it from old scrolls. The clan had once protected the village from a dragon that terrorised the region. The elder believed the egg might be the last of the clan, and that the mute dragon was its spirit. Kael was named the dragon’s steward.`

const chapter3 = `# Chapter 3: The Library

Corin the scholar, after years of wandering, found a ruined monastery in the Mountains of Ash. Its library held ancient texts that matched the feather pattern. The texts described a pact between the clan and the dragons, sealed in ash‑stone. The pact promised peace between humans and dragons if the egg was protected. Kael and Lyra travelled to the library to decipher the pact.`

const character = `# Character: Kael

Kael is a young man from a high‑altitude village. He found a dragon egg abandoned by the Council. He tends it patiently, and the hatchling becomes his companion. Kael is brave, curious, and carries the responsibility of protecting the last dragon of a fallen clan.`

const location = `# Location: The Village

The village is perched on the rim of the Mountains of Ash. The air is thin, the nights are cold. Houses are built of stone and wood. At the centre stands a small monastery whose library holds ancient texts about the clan‑dragon pact.`

const item = `# Item: The Egg

The egg is smooth, dark‑coloured, and fragile. Its shell bears a faint feather‑shaped scar – the seal of a long‑lost clan. Kael keeps it warm and, after a night of patient watching, watches it hatch into a small mute dragon.`

  const emptyResponses = new Array(6).fill("")
  const model = new MockModel([
    makeWriteCall("plan.md", plan),
    makeWriteCall("chapter1.md", chapter1),
    makeWriteCall("chapter2.md", chapter2),
    makeWriteCall("chapter3.md", chapter3),
    makeWriteCall("wiki/character/kael.md", character),
    makeWriteCall("wiki/location/village.md", location),
    makeWriteCall("wiki/item/egg.md", item),
    ...emptyResponses,
  ])

  console.log("\nParser self‑check (first response):")
  console.log(parseToolCalls(model.responses[0]))

  await model.init()

  // ────── 4️⃣  Run the AgentLoop. ──────
  const session = new Session({
    id: "storyteller-context-full-sid",
    agentName: "storyteller",
  })

  const loop = new AgentLoop(model, session, 8, {
    systemPrompt:
      "You are a writing agent. Use the `write` tool to create plan.md, three chapter files " +
      "(chapter1.md, chapter2.md, chapter3.md) and three wiki entries " +
      "(wiki/character/kael.md, wiki/location/village.md, wiki/item/egg.md). Do nothing else.",
    toolDefs: defaultToolDefs,
    toolHandlers: handlers,
    examples: "",
    templateName: "default",
  })

  const finalText = await loop.run("Write plan, three chapters and three wiki pages.")
  console.log("   finalText length:", finalText?.length)
  console.log("   workspace contents:", await fsp.readdir(baseDir).catch(() => []))

  // ────── 5️⃣  Verify the files. ──────
  const expectedFiles: Record<string, string> = {
    "plan.md": plan,
    "chapter1.md": chapter1,
    "chapter2.md": chapter2,
    "chapter3.md": chapter3,
    "wiki/character/kael.md": character,
    "wiki/location/village.md": location,
    "wiki/item/egg.md": item,
  }

  for (const [file, expected] of Object.entries(expectedFiles)) {
    const abs = path.join(baseDir, file)
    const exists = await fsp.access(abs).then(() => true).catch(() => false)
    checks.push({ name: `${file} exists on disk`, pass: exists })
    if (!exists) continue
    const onDisk = readFileSync(abs, "utf8")
    checks.push({
      name: `${file} content matches mock payload`,
      pass: onDisk === expected,
      detail: onDisk === expected ? "" : "file contents differ",
    })
  }

  // ────── 6️⃣  Verify the side‑store summaries. ──────
  const summaryKeywords: Record<string, string[]> = {
    "plan.md": ["Premise", "Kael", "Lyra"],
    "chapter1.md": ["Egg", "village"],
    "chapter2.md": ["feather", "clan"],
    "chapter3.md": ["Library", "scholar"],
    "wiki/character/kael.md": ["Kael", "dragon"],
    "wiki/location/village.md": ["village", "monastery"],
    "wiki/item/egg.md": ["Egg", "feather"],
  }

  for (const file of Object.keys(expectedFiles)) {
    checks.push({
      name: `${file} has a stored summary`,
      pass: ctx.summaries.has(file),
    })
    if (!ctx.summaries.has(file)) continue
    const summary = ctx.summaries.get(file) ?? ""
    // keyword presence – at least one of the expected keywords should appear
    const requiredKeywords = summaryKeywords[file] ?? []
    const keywordPass = requiredKeywords.some((kw) =>
      summary.toLowerCase().includes(kw.toLowerCase()),
    )
    checks.push({
      name: `${file} summary contains at least one expected keyword`,
      pass: keywordPass,
      detail: keywordPass
        ? ""
        : `missing one of: ${requiredKeywords.join(", ")}`,
    })
    checks.push({
      name: `${file} summary is a truncated version (≤ 121 chars)`,
      pass: summary.length <= 121,
    })
  }

  // ────── 7️⃣  Print summary view. ──────
  console.log("\nContext‑store contents (the “memory” the model would see later):")
  for (const [file, summary] of ctx.summaries) {
    console.log(`  • ${file} → ${summary}`)
  }

  console.log(`\nWorkspace preserved at: ${tmpRoot}`)
  summarizeChecks(checks)
}

function summarizeChecks(checks: Check[]) {
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
