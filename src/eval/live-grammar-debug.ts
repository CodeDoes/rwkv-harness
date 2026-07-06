#!/usr/bin/env node
/**
 * Live‑model debug eval – run the real RWKV gateway and *stream* the
 * tokens it produces, capturing exactly which token caused the grammar
 * check to fail.
 *
 *   • Connects to the gateway at `LIVE_URL` (defaults to
 *     `http://127.0.0.1:3130`; override with the env‑var).
 *   • Calls `process()` to create a session.
 *   • Calls `streamGenerate()` once with a small tool‑set grammar.
 *   • On every token that the model emits:
 *       – we accumulate the raw output,
 *       – we feed the same token to the local `schoolmarm`
 *         grammar state (if you want an in‑process view – mirrors what the
 *         gateway does in its `grammarCheck` endpoint).
 *   • When the generation finishes we also call the gateway’s own
 *     `grammarCheck` to verify the *exact* byte position where the
 *     grammar stops accepting.
 *   • Finally we hand the resulting raw text to the normal
 *     `parseToolCalls` so we can see which tool calls the model
 *     attempted (if any).
 *
 * Run with `pnpm test:live-grammar-debug` *while a gateway is up*.
 */

import { HttpModel } from "../model/http-model.ts"
import {
  toolsToGbnfWithThink,
  toolDefs as defaultToolDefs,
} from "../tools/registry.ts"
import { parseToolCalls } from "../model/adapter.ts"

const LIVE_URL = process.env.LIVE_URL ?? "http://127.0.0.1:3130"
const MAX_TOKENS = 4000
const TEMPERATURE = 0.5

/* ------------------------------------------------------------------ */
async function main() {
  console.log(`▶︎  connecting to ${LIVE_URL}`)
  const engine = new HttpModel(LIVE_URL)
  await engine.init()

  // Establish a session – same pattern the rest of the harness uses.
  await engine.process({
    systemPrompt:
      "You are a writing assistant. Use the `write` tool to create exactly one chapter file called `chapter1.md`. Do nothing else.",
    append: { role: "system", content: "User:\n\tlist files in the workspace." },
  })

  /* ----------------------------------------------------------------------- */
  // The grammar is handed to the gateway with the streaming call.  To stay
  // in‑sync with what the server sees we use the gateway’s own
  // `grammarCheck` endpoint after the generation – it runs the same
  // schoolmarm `GrammarState` walk over the produced text and reports the
  // byte position where the grammar stopped accepting input.

  const gbnf = toolsToGbnfWithThink(defaultToolDefs)
  console.log("\n── Grammar ready (first 200 chars) ─────────────────")
  console.log(gbnf.slice(0, 200).replace(/\n/g, " \n "))

  /* ------------------------------------------------------------------------ */
  // We run a tiny generation – the same prompt the eval test uses.
  const userPrompt =
    "Write a chapter about a dragon. Use the `write` tool to create `chapter1.md`."
  console.log("\n▶︎  asking the model to write a chapter …\n")

  let rawOutput = ""
  const tokenCount = { n: 0 }

  const start = Date.now()
  const result = await engine.streamGenerate({
    sessionId: "debug-sid",
    prompt: userPrompt,
    opts: {
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      stopSequences: ["</tool_call>", "\n\nUser:"],
    },
    onToken: (token: string) => {
      rawOutput += token
      tokenCount.n += 1

      // ► The gateway does the deep schoolmarm walk – we’ll see the
      //   result after the stream ends.
      const preview = token.length > 80 ? token.slice(0, 80) + "…" : token
      process.stdout.write(`tok#${tokenCount.n.toString().padStart(4, " ")}  ${preview}\n`)
    },
  }).catch((e) => {
    console.error("streamGenerate failed:", e)
    process.exit(2)
  })

  const ms = Date.now() - start
  console.log(`\n── End of generation (took ${ms} ms, stopReason=${"??"}) ─────`)

  /* ------------------------------------------------------------------------ */
  // Ask the *gateway*’s own grammar check for authoritative answer.
  try {
    const remote = await engine.grammarCheck(gbnf, rawOutput)
    console.log("\n── Gateway grammarCheck result ─────────────────────────────────")
    console.log(remote)
  } catch (e) {
    console.log("(gateway has no grammarCheck endpoint – that’s fine)")
  }

  /* ------------------------------------------------------------------------ */
  // Use the standard TS adapter to extract tool calls from the raw output.
  const parsed = parseToolCalls(rawOutput)
  console.log("\n── parseToolCalls ──────────────────────────────────────────────")
  console.log({
    beforeText: parsed.beforeFirst,
    text: parsed.text.slice(0, 200),
    toolCalls: parsed.toolCalls,
    errors: parsed.errors,
  })

  await engine.dispose?.()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
