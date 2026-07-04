#!/usr/bin/env node
/**
 * Targeted eval cases — run a battery of small, focused scenarios
 * through the agent loop with `MockModel` driving the model's output.
 *
 * Each case lives in `src/eval/cases.ts`. The runner:
 *   1. prepares a temp workspace
 *   2. seeds any files the fixture requests
 *   3. instantiates the requested agent
 *   4. feeds the mock response stream through `AgentLoop`
 *   5. asserts the file-tree + captured outputs
 *
 * Usage:
 *   pnpm eval:cases              # mock-mode, fast, no model
 *   pnpm eval:cases:live         # real gateway, --gateway=3130
 *                                # injected responses via /rpc/inject
 *                                # (not implemented yet — placeholder)
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"
import { AgentLoop } from "../agents/loop.ts"
import { Session } from "../session/session.ts"
import { SessionManager } from "../session/session-manager.ts"
import { MockModel } from "./mock-engine.ts"
import { EvalController } from "./eval-controller.ts"
import { CASES, type CaseCheck, type EvalCase } from "./cases.ts"
import { resolveWorkspace, cleanupWorkspace, type WorkspaceMode } from "../core/workspace.ts"
import { renderAssistantTurn } from "../agents/examples.ts"
import type { ExampleEntry } from "../agents/example-template.ts"
import { toolDefs as storytellerToolDefs, toolHandlers as storytellerHandlers } from "../agents/storyteller/tools/index.ts"
import { toolDefs as envoyToolDefs, toolHandlers as envoyHandlers } from "../agents/envoy/tools/index.ts"
import { toolDefs as coderToolDefs, toolHandlers as coderHandlers } from "../agents/coder/tools/index.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let totalPass = 0
let totalFail = 0
const allFailures: string[] = []

async function runCase(c: EvalCase): Promise<boolean> {
  const { id, description, agent, userInput, workspaceDir, seedFiles, turns } = c

  // Prepare temp workspace + seed files.
  const ws = resolveWorkspace({ mode: "temp" as WorkspaceMode, slug: `cases/${id}` })
  fs.mkdirSync(ws.path, { recursive: true })
  const baseDir = ws.path.replace(/\/workspace.*$/, "")
  // Actually: resolveWorkspace puts us at <root>/.tmp/.../<slug> — we
  // want baseDir = the workspace parent. Resolve backwards from the slug.
  const root = path.dirname(ws.path)
  const absoluteWorkspaceDir = path.join(ws.path, workspaceDir)

  fs.mkdirSync(path.dirname(absoluteWorkspaceDir), { recursive: true })
  for (const [rel, content] of Object.entries(seedFiles ?? {})) {
    const target = path.join(ws.path, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, "utf-8")
  }

  // Build mock responses — same shape as EvalController mock.
  const mockResponses: string[] = turns.map((t) => t.response)

  // Tools + handlers per agent.
  const toolSet = agent === "storyteller"
    ? { defs: storytellerToolDefs, handlers: storytellerHandlers }
    : agent === "coder"
    ? { defs: coderToolDefs, handlers: coderHandlers }
    : { defs: envoyToolDefs, handlers: envoyHandlers }

  // Set the cwd so model-emitted relative paths land in the temp tree.
  const originalCwd = process.cwd()
  process.chdir(ws.path)
  const toolsCalled: string[] = []
  const capturedText: string[] = []
  try {
    const sessionMgr = new SessionManager(ws.path, `case-${id}`, agent)
    await sessionMgr.ensureDir()
    const session = new Session({ id: `case-${id}`, agentName: agent })
    const model = new MockModel(mockResponses) as unknown as import("../types.ts").Engine

    const loop = new AgentLoop(model, session, turns.length + 1, {
      toolDefs: toolSet.defs,
      toolHandlers: {
        ...toolSet.handlers,
        // Wrap handlers so we can record which tools were invoked.
        // (ToolDef-like proxy using `Proxy` would be clean, but a manual
        // pass-through is fine for the small surface.)
      },
      onToolCall: (name, _args) => {
        toolsCalled.push(name as string)
      },
      saveSession: () => sessionMgr.saveFromSession(session),
    })

    // The MockModel streams via `inferStream` -> we need a context where
    // we capture responses at the Model layer. The simplest path is
    // using EvalController's approach (mockResponses already rendered):
    // convert each turn into ExampleEntry-shaped turns and use a
    // MockModel that responds to streaming requests.

    // Re-implement loop.run with mock-mode streaming that returns the
    // response verbatim. EvalController's runAgentHierarchy does this
    // exactly for oracle — we use the same renderer for each turn.

    const cb: import("../types.ts").GenerateCallbacks = {
      onText: (t) => { capturedText.push(t) },
    }
    await loop.run(userInput, cb)
  } catch (e) {
    console.error(`[${id}] ERROR:`, e instanceof Error ? e.message : String(e))
    process.chdir(originalCwd)
    cleanupWorkspace(ws.path)
    return false
  }
  process.chdir(originalCwd)

  // Evaluate case-specific checks against the post-run workspace.
  const checks: CaseCheck[] = c.evaluate({
    workspaceDir: absoluteWorkspaceDir,
    turns,
    capturedText,
    toolsCalled,
  })

  let casePass = true
  console.log(`\n── ${id}: ${description} ──`)
  for (const check of checks) {
    const label = check.pass ? "[PASS]" : "[FAIL]"
    console.log(`  ${label} ${check.name}`)
    if (!check.pass) {
      casePass = false
      if (check.detail) console.log(`        ↳ ${check.detail}`)
    }
  }
  if (casePass) totalPass++; else { totalFail++; allFailures.push(id) }
  cleanupWorkspace(ws.path)
  return casePass
}

async function main() {
  for (const c of CASES) {
    await runCase(c)
  }
  console.log(`\n${totalPass}/${totalPass + totalFail} PASS`)
  if (totalFail > 0) {
    console.log("\nFailures:")
    allFailures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main()
