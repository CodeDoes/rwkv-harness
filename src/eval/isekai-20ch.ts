#!/usr/bin/env node
/**
 * Generate a 20‑chapter isekai fantasy story, ~2000 words per chapter,
 * with the live RWKV model.
 *
 *   • This script talks to the gateway via HTTP (so no double‑load).
 *   • Each chapter is a *separate* generation round, producing 2000‑ish
 *     words (capped by `maxTokens`).  If the model stops early we just
 *     keep what we got.
 *   • The output for every chapter is written to a unique file under
 *     a fresh temporary directory and the path is logged.
 *
 * The story will most likely not hold a single narrative thread (the
 * model only sees its own prompt and has no memory across the 20
 * generations) – this is a smoke‑test of the long‑generation pipeline
 * rather than a coherent manuscript.
 */

import { promises as fsp, writeFileSync } from "fs"
import * as path from "path"
import * as os from "os"

import { HttpModel } from "../model/http-model.ts"

const LIVE         = process.env.LIVE_URL ?? "http://127.0.0.1:3130"
const TOTAL_CHAPTERS = 20
const WORDS_PER    = 2000
const MAX_TOKENS   = 3000 // ≈ 2000 words of RWKV tokenisation

async function main() {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "isekai-"))
  console.log(`▶︎  writing 20 chapters into ${outDir}`)

  const engine = new HttpModel(LIVE)
  await engine.init()
  await engine.process({
    systemPrompt:
      "You are a fantasy author writing an isekai (alternate‑world) story in long form. " +
      "Each chapter must start with a title (e.g. `# Chapter X: …`) and be roughly 2000 words. " +
      "Use vivid imagery and continuous prose.",
    append: { role: "assistant", content: "Ready to begin the saga." },
  })

  for (let i = 1; i <= TOTAL_CHAPTERS; i++) {
    const file = path.join(outDir, `chapter_${i.toString().padStart(2, "0")}.md`)
    const prompt =
      `Write chapter ${i} of a 20‑chapter isekai fantasy saga. Aim for ~${WORDS_PER} words.`
    process.stdout.write(`\n\n=== chapter ${i} :: streaming → ${file} ===\n`)
    let acc = ""
    const res = await engine.streamGenerate({
      sessionId: `isekai-${i}`,
      prompt,
      opts: {
        maxTokens: MAX_TOKENS,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ["\n\nUser:", "# Chapter "], // crude "next‑chapter" guard
      },
      onToken: (tok: string) => {
        acc += tok
        // Print newline‑separated raw output to stderr (keeps the live log tidy)
        process.stderr.write(tok)
      },
    })
    writeFileSync(file, acc)
    console.log(`\n[chap ${i}] stopReason=${res.stopReason} chars=${acc.length}`)
  }

  await engine.dispose?.()
  console.log(`\n✅  20‑chapter run finished – files are in ${outDir}`)
}

main().catch((err) => {
  console.error("\nFATAL:", err)
  process.exit(1)
})
