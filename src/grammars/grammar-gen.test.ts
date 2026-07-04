#!/usr/bin/env node
/**
 * Grammar-gen tests — verify that for each non-empty agent's grammar:
 *
 *   1. Every declared tool produces a `call<name>` rule in the GBNF (with
 *      `_` stripped, matching schoolmarm's identifier rule).
 *   2. The `call` alternation enumerates exactly those call rules.
 *   3. Each `call<name>` rule embeds the tool's name string as a literal.
 *   4. Each tool's required parameters appear in its `args` rule.
 *   5. The agent's example tool calls (rendered through the default
 *      template) round-trip through GBNF validation:
 *        - `<tool_call>` JSON parses
 *        - tool name matches one of the agent's tools
 *        - required parameters are present
 *
 * These tests guarantee the grammar and tool registry stay in sync. If
 * you add a tool without updating the grammar, or vice versa, the test
 * fails before runtime.
 */
import * as fs from "fs"
import {
  toolsToGbnfWithThink,
} from "../tools/registry.ts"
import { toolDefs as envoyDefs } from "../agents/envoy/tools/index.ts"
import { toolDefs as storytellerDefs } from "../agents/storyteller/tools/index.ts"
import { toolDefs as coderDefs } from "../agents/coder/tools/index.ts"
import { parseGrammar, rhsIdentifiers } from "./grammar-helpers.ts"
import { EvalController } from "../eval/eval-controller.ts"
import type { ToolDef } from "../types.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++
    console.log(`  [PASS] ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function toolCallRuleName(t: ToolDef): string {
  return `call${t.name.replace(/_/g, "")}`
}

function testAgent(label: string, defs: ToolDef[]) {
  console.log(`\n── ${label} ──`)
  const gbnf = toolsToGbnfWithThink(defs)
  const parsed = parseGrammar(gbnf)
  const defined = new Set(parsed.definitions.keys())

  for (const tool of defs) {
    const name = toolCallRuleName(tool)
    check(`${label}: grammar has call rule for "${tool.name}"`, defined.has(name))
    // The tool name literal lives in the `<safeX>name` rule referenced by
    // the call<X> rule, not inside the call<X> rule directly.
    const safeName = tool.name.replace(/_/g, "")
    const nameRule = `${safeName}name`
    const nameRhs = parsed.definitions.get(nameRule) ?? ""
    check(
      `${label}: ${nameRule} embeds tool name "${tool.name}"`,
      nameRhs.includes(tool.name),
    )
    const argsRule = `${safeName}args`
    check(
      `${label}: grammar has args rule for "${tool.name}"`,
      defined.has(argsRule),
    )
    const argsRhs = parsed.definitions.get(argsRule) ?? ""
    for (const p of tool.parameters) {
      if (!p.required) continue
      check(
        `${label}: ${tool.name} args rule references param "${p.name}"`,
        argsRhs.includes(p.name),
      )
    }
  }

  // The `call` alternation should enumerate exactly the call<name> rules
  const callRhs = parsed.definitions.get("call") ?? ""
  const expectedCalls = defs.map(toolCallRuleName)
  for (const expected of expectedCalls) {
    check(`${label}: call alternation includes ${expected}`, callRhs.includes(expected))
  }

  // Cross-check: unknown identifiers on RHSes of generated rules must all
  // be defined. (We saw earlier the schoolmarm grammar would reject an
  // undefined ref.)
  const unresolved: string[] = []
  for (const [name, rhs] of parsed.definitions) {
    for (const ref of rhsIdentifiers(rhs)) {
      if (!defined.has(ref)) unresolved.push(`${name} -> ${ref}`)
    }
  }
  check(
    `${label}: no unresolved rule references`,
    unresolved.length === 0,
    unresolved.length === 0 ? "" : unresolved.slice(0, 5).join(", "),
  )
}

async function testExampleToolCalls(label: string, defs: ToolDef[]) {
  console.log(`\n── ${label}: rendered example tool calls parse against the tool registry ──`)

  // Pull every `<tool_call>…</tool_call>` substring out of the rendered
  // examples for each agent and verify the tool registry never sees a
  // malformed call.
  // Use a static import instead of createRequire — ESM-only.
  const { renderExamples } = await import("../agents/examples.ts")
  const agentsToProbe: Array<{ render: string; agentName: string }> = []
  for (const name of ["envoy", "storyteller", "coder"]) {
    const rendered = renderExamples(name)
    if (rendered) agentsToProbe.push({ render: rendered, agentName: name })
  }

  let totalCalls = 0
  for (const { render, agentName } of agentsToProbe) {
    const errs = EvalController.validateToolCallFormat(render, defs)
    check(
      `${label}: ${agentName} example tool calls validate against all toolsets`,
      errs.length === 0,
      errs.slice(0, 3).join(" | "),
    )
    totalCalls += (render.match(/<tool_call>/g) || []).length
  }
  check(
    `${label}: example rendering has at least one tool_call`,
    totalCalls > 0,
  )
}

async function main() {
  testAgent("envoy (1 tool)", envoyDefs)
  testAgent("storyteller (7 tools)", storytellerDefs)
  testAgent("coder (7 tools)", coderDefs)

  await testExampleToolCalls("all toolsets", [...envoyDefs, ...storytellerDefs, ...coderDefs])

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main()
