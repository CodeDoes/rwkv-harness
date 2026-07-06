#!/usr/bin/env node
/**
 * Grammar-leaniant vs strict validator tests.
 *
 *   validateAssistantOutput (strict)         — used for examples, drift
 *                                             detection
 *   validateAssistantOutputLenient (grammar) — used for live model
 *                                             output, asserts only the
 *                                             grammar-level contract
 *
 * The grammar-level contract is:
 *   - the output begins with a `\t`-indented line
 *   - no echoed role markers (`system:`, `User:`, `Assistant:`)
 *   - balanced XML tags
 *   - every <tool_call>…</tool_call> parses as JSON with a string name
 *
 * Strict in addition requires every prose line to be `\t`-prefixed
 * (no flush-left free text).
 *
 * The grammar-walk path uses the napi binding's `grammar_check`
 * (real schoolmarm char-by-char accept path). It's invoked through
 * `validateAssistantOutputGrammar` so we exercise the same route the
 * live inference engine uses.
 */
import { createRequire } from "node:module"
import { EvalController } from "../eval/eval-controller.ts"
import { toolsToGbnfWithThink } from "../tools/registry.ts"

const _require = createRequire(import.meta.url)

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`) }
}

const validThinkText = '\t<think>\n\tGood\n\t</think>\n\tI agree.'
const validToolCall = '\t<tool_call>\n\t{"name":"read","arguments":{"path":"test.md"}}\n\t</tool_call>'

async function main() {
  console.log("\n── strict accepts valid layouts ──")
  check("strict accepts think+text", EvalController.validateAssistantOutput(validThinkText).length === 0)
  check("strict accepts tool_call", EvalController.validateAssistantOutput(validToolCall).length === 0)

  console.log("\n── lenient accepts valid layouts ──")
  check("lenient accepts think+text", EvalController.validateAssistantOutputLenient(validThinkText).length === 0)
  check("lenient accepts tool_call", EvalController.validateAssistantOutputLenient(validToolCall).length === 0)

  console.log("\n── strict rejects known-bad patterns ──")
  check(
    "strict rejects \\tsystem: prefix",
    EvalController.validateAssistantOutput('\tsystem:\n\tWelcome to the system.').length > 0,
  )
  check(
    "strict rejects \\tUser: in output (role confusion)",
    EvalController.validateAssistantOutput('\t<think>\n\tOK\n\t</think>\n\tUser:\n\tHello').length > 0,
  )
  check(
    "strict rejects missing \\t prefix",
    EvalController.validateAssistantOutput('<think>\nNo tab here\n</think>').length > 0,
  )
  check(
    "strict rejects unclosed <think> tag",
    EvalController.validateAssistantOutput('\t<think>\n\tUnclosed').length > 0,
  )

  console.log("\n── lenient rejects only the GRAMMAR-level breakages ──")
  // role echo: both reject
  check(
    "lenient rejects \\tUser: role echo",
    EvalController.validateAssistantOutputLenient('\t\tUser:\n\tHello').length > 0,
  )

  // tool_call JSON validity: both reject
  check(
    "lenient rejects malformed tool_call JSON",
    EvalController.validateAssistantOutputLenient('\t<tool_call>\n\t{not json}\n\t</tool_call>').length > 0,
  )
  check(
    "lenient rejects tool_call missing name",
    EvalController.validateAssistantOutputLenient('\t<tool_call>\n\t{"arguments":{}}\n\t</tool_call>').length > 0,
  )

  // tab indent: strict rejects the mixed indentation; lenient accepts the
  // same prose because the grammar's `text` rule allows free prose after
  // the first tab-indented line.
  const noTab = '\t<think>\nFree prose here\nMore free prose\n\t</think>'
  check("strict rejects prose without leading \\t", EvalController.validateAssistantOutput(noTab).length > 0)
  check("lenient accepts prose without leading \\t (grammar allows free text)", EvalController.validateAssistantOutputLenient(noTab).length === 0)

  // unclosed tag: both reject
  check(
    "lenient rejects unclosed <think>",
    EvalController.validateAssistantOutputLenient('\t<think>\n\tno close').length > 0,
  )

  // Think block free text WITH tabs: lenient accepts prose-paragraph format
  const vsMixedTabs = '\t<think>\n\tStep one\n\tStep two — second line\n\t</think>\n\tResult: ok.'
  check("lenient accepts block-indented body", EvalController.validateAssistantOutputLenient(vsMixedTabs).length === 0)

  console.log("\n── cross-check validateExampleFormat still strict ──")
  // validateExampleFormat was unchanged; both reject the same badly-formed example
  check(
    "validateExampleFormat rejects < in text content",
    EvalController.validateExampleFormat(
      'Assistant:\n\tHello <world>',
      [{ name: "read", description: "", parameters: [{ name: "path", type: "string", description: "", required: true }] }],
    ).length > 0,
  )

  // ── grammar-walk path: real schoolmarm via napi binding ──
  const binding = _require("/home/kit/dev/rwkv-harness/native/rwkv-bindings/rwkv-bindings.linux-x64-gnu.node") as {
    RwSession: new () => { grammarCheck: (gbnf: string, text: string) => { ok: boolean; firstFail: number; acceptedTokens: number; remainingTokens: number } }
  }
  const session = new binding.RwSession()
  const toolDefs = [
    { name: "read", description: "Read", parameters: [{ name: "path", type: "string", description: "Path", required: true }] },
    { name: "ls", description: "List", parameters: [{ name: "dir", type: "string", description: "Dir", required: true }] },
  ]
  const gbnf = toolsToGbnfWithThink(toolDefs)
  const grammarEngine = { grammarCheck: (g: string, t: string) => Promise.resolve(session.grammarCheck(g, t)) }
  const grammarEngineTyped = grammarEngine as unknown as { grammarCheck: (g: string, t: string) => Promise<{ ok: boolean; firstFail: number; acceptedTokens: number; remainingTokens: number }> }

  console.log("\n── grammar-walk (real schoolmarm) ──")
  const thinking = "\t<think>\n\tOK\n\t</think>\n\t<tool_call>\n\t{\"name\":\"ls\",\"arguments\":{\"dir\":\"plans\"}}\n\t</tool_call>"
  const toolCall = "\t<tool_call>\n\t{\"name\":\"ls\",\"arguments\":{\"dir\":\"plans\"}}\n\t</tool_call>"
  const brokenCall = "\t<tool_call>\n\t{not json}\n\t</tool_call>"

  await runGrammarWalk()

  async function runGrammarWalk() {
    const okThink    = await EvalController.validateAssistantOutputGrammar(thinking, gbnf, grammarEngineTyped)
    const okCall     = await EvalController.validateAssistantOutputGrammar(toolCall, gbnf, grammarEngineTyped)
    const brokenRes  = await EvalController.validateAssistantOutputGrammar(brokenCall, gbnf, grammarEngineTyped)
    check("grammar-walk accepts think+tool_call", okThink.length === 0)
    check("grammar-walk accepts valid tool_call", okCall.length === 0)
    check("grammar-walk rejects broken tool_call", brokenRes.length > 0)
  }

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
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
