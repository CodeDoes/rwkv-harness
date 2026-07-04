#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { spawn } from "child_process"
import { fileURLToPath } from "url"
import { EvalController, type Check } from "./eval-controller.ts"
import { loadAgent } from "../agents/agent-loader.ts"
import { renderExamples, renderAssistantTurn } from "../agents/examples.ts"
import type { ExampleEntry } from "../agents/example-template.ts"
import type { ToolDef, Engine } from "../types.ts"
import { HttpModel } from "../model/http-model.ts"
import { TraceWriter } from "./trace-writer.ts"
import { LogStream } from "../core/log-stream.ts"

// Eval-wide progress mirror → both stderr AND `.eval.log` on disk so
// `pnpm eval:logs` / `pnpm eval:tail-logs` can surface partial output.
const ELOG_PATH = path.resolve(process.cwd(), ".eval.log")
const elog = new LogStream({ path: ELOG_PATH, mirror: "stderr", prefix: "" })
function eLog(msg: string): void {
  elog.line(msg)
}
eLog(`[eval] start pid=${process.pid} cwd=${process.cwd()}`)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "../..")

// Active model reference shared with signal handlers so an interrupt
// (Ctrl+C) can forward a stop signal to the gateway before exiting.
let activeModel: Engine | null = null
let activeGatewayProc: import("child_process").ChildProcess | null = null

const USER_INPUT = "Create a story about dragons with 3 first chapters and an up-to-date wiki."

// ── Oracle content ──

const PLAN_CONTENT = `# The Dragon's Legacy\n\nA young blacksmith discovers a dying dragon and must choose between saving it and protecting his village.\n\n## Chapters\n1. The Discovery\n2. The Bond\n3. The Sacrifice\n\n## Wiki\n- Character: Lyra (dragon), Kael (blacksmith)\n- Location: Emberhold village, Dragon's Peak\n- Faction: The Ashen Council\n`
const CH1_CONTENT = `# Chapter 1: The Discovery\n\nThe forge fire hissed as Kael plunged the red-hot steel into the water. A shadow crossed the window. He looked up and saw nothing but dark trees swaying in the wind. Then he heard it: a low, rumbling moan that seemed to shake the very ground beneath his feet.\n\nHe grabbed his lantern and stepped outside. The sound grew louder, and with it came a faint orange glow from behind the ridge. Kael climbed the rocky path, his heart pounding. At the top, he froze.\n\nA massive creature lay crumpled in the ravine, its bronze scales cracked and oozing. One eye opened slowly, fixing him with a gaze that was both fierce and pleading. Kael whispered, \"You are real.\" The dragon let out a soft whimper. \"Help me,\" she breathed. \"Please.\"\n`
const CH2_CONTENT = `# Chapter 2: The Bond\n\nKael brought water from the stream. The dragon drank, her breathing steadying. He sat beside her, watching the stars emerge. \"What is your name?\" he asked. The dragon turned her head. \"Lyra,\" she said. \"I am the last of my kind. The Ashen Council hunted us down one by one.\"\n\nKael built a fire. Lyra told him of the old world, when dragons ruled the skies and humans lived in awe beneath them. \"They fear what they do not understand,\" Kael said. Lyra nodded. \"And fear makes people cruel.\"\n\nIn the days that followed, Kael tended to Lyra's wounds. She grew stronger. He climbed onto her back, and she spread her wings for the first time in months. The wind rushed past them as they soared above the village. Kael shouted with joy.\n`
const CH3_CONTENT = `# Chapter 3: The Sacrifice\n\nThe Ashen Council arrived at dawn. Three figures in gray cloaks stood at the village gate. \"We know you harbor a dragon,\" the leader said. \"Hand it over, or the village burns.\"\n\nKael stood before them. \"She is not a thing to hand over. She is my friend.\" The leader sneered. \"Then you will burn with her.\"\n\nLyra emerged from the ridge, her scales gleaming in the morning light. She spread her wings and roared. The council stumbled back. \"You wish to fight?\" Lyra said. \"I have no fight left in me. I offer myself. Let the boy go.\"\n\nThey took her away in iron chains. Kael watched until she disappeared over the horizon. That night, he found a single bronze scale lying on his doorstep. He held it tight and whispered, \"I will find you.\"\n`
const WIKI_ERYNDOR = `# Lyra\n\n**Role:** Bronze dragon, last of her kind\n**Age:** 427 years\n**Appearance:** Bronze scales, golden eyes, wingspan of 30 feet\n**Personality:** Wise, weary, fiercely protective of those she trusts\n**Backstory:** Lyra watched her entire species hunted by the Ashen Council. She fled to the mountains near Emberhold, where her injuries finally caught up with her. Kael found her and nursed her back to health, forging an unlikely bond.\n`
const WIKI_DRAGON_PEAK = `# Dragon's Peak\n\n**Location:** Mountain range east of Emberhold\n**Description:** The highest peak in the region, named for the dragons that once nested there. The summit is perpetually shrouded in mist, and the caves beneath hold ancient dragon-carved tunnels. The locals say that on quiet nights, you can still hear the echo of dragon songs.\n`
const WIKI_EMERALD_CLAW = `# The Ashen Council\n\n**Type:** Anti-dragon faction\n**Leader:** Councillor Maren\n**Headquarters:** The Ivory Tower, capital city\n**Goal:** Eliminate all remaining dragons from the realm\n**Methods:** Use of ash-magic that suppresses dragon fire. Trackers with enchanted compasses that point toward dragon blood. Bounty hunters paid per scale delivered to the council vault.\n`

// ── Oracle mode ──

async function runOracle(baseDir: string): Promise<boolean> {
  console.error("── Oracle mode (envoy → storyteller) ──")
  const storyPath = "workspace/dragons"
  const jobTask = `${USER_INPUT} Write files to ${storyPath}`

const trace = new TraceWriter("oracle").open({ mode: "oracle", baseDir })

  function tc(name: string, args: Record<string, unknown>): ExampleEntry {
    return { type: "tool_call", content: JSON.stringify({ name, arguments: args }) }
  }

  const mockTurns: ExampleEntry[][] = [
    [{ type: "think", content: "User wants a dragon story. Envoy delegates to storyteller." }, { type: "text", content: "I'll delegate this to the storyteller." }, tc("spawn_agent", { agent: "storyteller", task: jobTask, workspace: storyPath })],
    [{ type: "think", content: "Check existing workspace contents before creating anything." }, { type: "text", content: "Let me check what exists first." }, tc("ls", { path: "workspace" })],
    [{ type: "think", content: "Start with the plan file." }, { type: "text", content: "Writing plan." }, tc("write", { path: "workspace/dragons/_plan.md", content: PLAN_CONTENT })],
    [{ type: "think", content: "Write chapter 1 with character introduction and dialogue." }, { type: "text", content: "Chapter 1." }, tc("write", { path: "workspace/dragons/chapter-001.md", content: CH1_CONTENT })],
    [{ type: "think", content: "Write chapter 2 building on the bond between characters." }, { type: "text", content: "Chapter 2." }, tc("write", { path: "workspace/dragons/chapter-002.md", content: CH2_CONTENT })],
    [{ type: "think", content: "Write chapter 3 with the climax and resolution." }, { type: "text", content: "Chapter 3." }, tc("write", { path: "workspace/dragons/chapter-003.md", content: CH3_CONTENT })],
    [{ type: "think", content: "Now create wiki entries." }, { type: "text", content: "Wiki character." }, tc("write", { path: "workspace/dragons/wiki/character/eryndor.md", content: WIKI_ERYNDOR })],
    [tc("write", { path: "workspace/dragons/wiki/location/dragon-peak.md", content: WIKI_DRAGON_PEAK })],
    [tc("write", { path: "workspace/dragons/wiki/faction/emerald-claw.md", content: WIKI_EMERALD_CLAW })],
    [{ type: "text", content: "Created _plan.md, chapter-001.md, chapter-002.md, chapter-003.md, wiki/character/eryndor.md, wiki/location/dragon-peak.md, wiki/faction/emerald-claw.md." }],
  ]

  const mockResponses = mockTurns.map(t => renderAssistantTurn(t))

  const model = EvalController.createMockModel(mockResponses)
  const envoy = await loadAgent("envoy")
  const storyteller = await loadAgent("storyteller")

  const controller = new EvalController({
    baseDir,
    model,
    sessionId: "envoy-dragons-oracle",
    trace,
  })

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const result = await controller.runAgentHierarchy({
    envoy,
    storyteller,
    userInput: USER_INPUT,
    onSpawnResult: () => ({
      filesCreated: [
        "workspace/dragons/_plan.md",
        "workspace/dragons/chapter-001.md",
        "workspace/dragons/chapter-002.md",
        "workspace/dragons/chapter-003.md",
        "workspace/dragons/wiki/character/eryndor.md",
        "workspace/dragons/wiki/location/dragon-peak.md",
        "workspace/dragons/wiki/faction/emerald-claw.md",
      ],
    }),
  })

  console.error(`\nEnvoy tool calls: 1 (spawn_agent)`)
  console.error(`Storyteller tool calls: ${result.subToolCalls}`)

  const envoyToolErr = EvalController.validateToolCallFormat(mockResponses[0], envoy.toolDefs)
  const stToolDefs: ToolDef[] = storyteller.toolDefs
  const stErrors: string[] = []
  for (let i = 1; i < mockResponses.length; i++) {
    if (mockResponses[i].includes("<tool_call>")) {
      stErrors.push(...EvalController.validateToolCallFormat(mockResponses[i], stToolDefs))
    }
  }

  const envoyGrammarErr = await EvalController.validateToolGrammar(envoy.toolDefs)
  const stGrammarErr = await EvalController.validateToolGrammar(stToolDefs)

  // Validate rendered examples against GBNF grammar
  const envoyExampleText = renderExamples("envoy")
  const stExampleText = renderExamples("storyteller")
  const envoyExampleErr = EvalController.validateExampleFormat(envoyExampleText, envoy.toolDefs)
  const stExampleErr = EvalController.validateExampleFormat(stExampleText, stToolDefs)

  // ── Static oracle format-validation tests (prove validators catch bad output) ──
  const allDefs = [...envoy.toolDefs, ...stToolDefs]

  const validThinkOutput = '\t<think>\n\tGood\n\t</think>\n\tI agree.'
  const validToolOutput = '\t<tool_call>\n\t{"name":"read","arguments":{"path":"test.md"}}\n\t</tool_call>'

  const formatChecks: Check[] = [
    // validateAssistantOutput: valid input passes
    { name: "validateAssistantOutput: accepts valid think+text", pass: EvalController.validateAssistantOutput(validThinkOutput).length === 0 },
    { name: "validateAssistantOutput: accepts valid tool_call", pass: EvalController.validateAssistantOutput(validToolOutput).length === 0 },

    // validateAssistantOutput: rejects known-bad patterns
    {
      name: "rejects \\tsystem: prefix (echoed instructions)",
      pass: (() => {
        const errs = EvalController.validateAssistantOutput('\tsystem:\n\tWelcome to the system.')
        return errs.length > 0
      })(),
    },
    {
      name: "rejects \\tUser: in output (role confusion)",
      pass: (() => {
        const errs = EvalController.validateAssistantOutput('\t<think>\n\tOK\n\t</think>\n\tUser:\n\tHello')
        return errs.length > 0
      })(),
    },
    {
      name: "rejects missing \\t prefix",
      pass: (() => {
        const errs = EvalController.validateAssistantOutput('<think>\nNo tab here\n</think>')
        return errs.length > 0
      })(),
    },
    {
      name: "rejects unclosed <think> tag",
      pass: (() => {
        const errs = EvalController.validateAssistantOutput('\t<think>\n\tUnclosed')
        return errs.length > 0
      })(),
    },
    // validateToolCallFormat: rejects bad JSON
    {
      name: "validateToolCallFormat: rejects invalid JSON",
      pass: (() => {
        const errs = EvalController.validateToolCallFormat('\t<tool_call>\n\t{invalid json}\n\t</tool_call>', allDefs)
        return errs.length > 0
      })(),
    },
    {
      name: "validateToolCallFormat: rejects unknown tool name",
      pass: (() => {
        const errs = EvalController.validateToolCallFormat('\t<tool_call>\n\t{"name":"nonexistent_tool","arguments":{"path":"x"}}\n\t</tool_call>', allDefs)
        return errs.length > 0
      })(),
    },
    // validateExampleFormat: reject bad example format
    {
      name: "validateExampleFormat: rejects < in text content",
      pass: (() => {
        const badRendered = 'Assistant:\n\tHello <world>'
        const errs = EvalController.validateExampleFormat(badRendered, allDefs)
        return errs.length > 0
      })(),
    },
    {
      name: "validateExampleFormat: rejects unclosed tool_call in example",
      pass: (() => {
        const badRendered = 'Assistant:\n\t<tool_call>\n\t{"name":"read","arguments":{"path":"x"}}\n\t</tool_call>\n\t<tool_call>\n\t{"name":"write",'
        const errs = EvalController.validateExampleFormat(badRendered, allDefs)
        return errs.length > 0
      })(),
    },
  ]

  const checks: Check[] = [
    // Workspace
    { name: "workspace dir", pass: fs.existsSync("workspace") && fs.statSync("workspace").isDirectory() },
    { name: "story dir", pass: fs.existsSync("workspace/dragons") },
    // Plan & chapters
    { name: "plan file", pass: fs.existsSync("workspace/dragons/_plan.md") },
    { name: "chapter 1", pass: fs.existsSync("workspace/dragons/chapter-001.md") },
    { name: "chapter 2", pass: fs.existsSync("workspace/dragons/chapter-002.md") },
    { name: "chapter 3", pass: fs.existsSync("workspace/dragons/chapter-003.md") },
    // Wiki dirs and counts (supports multiple entries per category)
    { name: "wiki character dir", pass: fs.existsSync("workspace/dragons/wiki/character") },
    { name: ">=1 character entry", pass: controller.countFilesInDir("workspace/dragons", "wiki", "character") >= 1 },
    { name: "wiki location dir", pass: fs.existsSync("workspace/dragons/wiki/location") },
    { name: ">=1 location entry", pass: controller.countFilesInDir("workspace/dragons", "wiki", "location") >= 1 },
    { name: "wiki faction dir", pass: fs.existsSync("workspace/dragons/wiki/faction") },
    { name: ">=1 faction entry", pass: controller.countFilesInDir("workspace/dragons", "wiki", "faction") >= 1 },
    // Content (mock writes exact paths, so these still hold)
    { name: "plan content correct", pass: fs.readFileSync("workspace/dragons/_plan.md", "utf-8") === PLAN_CONTENT },
    { name: "ch1 content correct", pass: fs.readFileSync("workspace/dragons/chapter-001.md", "utf-8") === CH1_CONTENT },
    { name: "ch2 content correct", pass: fs.readFileSync("workspace/dragons/chapter-002.md", "utf-8") === CH2_CONTENT },
    { name: "ch3 content correct", pass: fs.readFileSync("workspace/dragons/chapter-003.md", "utf-8") === CH3_CONTENT },
    { name: "wiki eryndor correct", pass: fs.readFileSync("workspace/dragons/wiki/character/eryndor.md", "utf-8") === WIKI_ERYNDOR },
    { name: "wiki dragon-peak correct", pass: fs.readFileSync("workspace/dragons/wiki/location/dragon-peak.md", "utf-8") === WIKI_DRAGON_PEAK },
    { name: "wiki emerald-claw correct", pass: fs.readFileSync("workspace/dragons/wiki/faction/emerald-claw.md", "utf-8") === WIKI_EMERALD_CLAW },
    // Agent usage
    { name: "envoy spawned agent", pass: result.subToolCalls >= 1 },
    { name: "storyteller made at least 8 tool calls", pass: result.subToolCalls >= 8 },
    { name: "all mock responses consumed", pass: model.callCount === mockResponses.length },
    { name: "envoy tool call format valid", pass: envoyToolErr.length === 0 },
    { name: "storyteller tool calls format valid", pass: stErrors.length === 0 },
    { name: "envoy grammar valid", pass: envoyGrammarErr === null },
    { name: "storyteller grammar valid", pass: stGrammarErr === null },
    { name: "envoy example format valid (GBNF)", pass: envoyExampleErr.length === 0 },
    { name: "storyteller example format valid (GBNF)", pass: stExampleErr.length === 0 },
    { name: "mock responses start with \\n\\t", pass: mockResponses.every((r, i) => { const ok = r.startsWith("\n\t"); if (!ok) console.error(`  mock response ${i} bad prefix: ${JSON.stringify(r.slice(0, 6))}`); return ok }) },
    { name: "tool responses traced", pass: result.toolResponseCount >= 8 },
    // Static format-validation tests (prove validators catch bad output)
    ...formatChecks,
  ]

  const allPass = EvalController.reportVerification("Oracle Verification", checks, trace)
  trace.close()
  console.error(`\nTrace: ${trace.path}`)
  process.chdir(originalCwd)
  return allPass
}

// ── Live mode ──

/**
 * Wait until the gateway's `/rpc/health` reports `status: "ok"`.
 * Returns the `HttpModel` to use, or `null` if the deadline expires.
 *
 * Connection errors (ECONNREFUSED, DNS failures) are treated as "not yet up"
 * rather than "dead" — keeps retrying until the deadline. HTTP errors (500,
 * etc.) are also treated as "still loading".
 */
async function tryConnectGateway(port = 3030, opts: { waitMs?: number; pollMs?: number } = {}): Promise<Engine | null> {
  const { waitMs = 5 * 60 * 1000, pollMs = 2000 } = opts
  const url = `http://127.0.0.1:${port}/rpc/health`
  const deadline = Date.now() + waitMs
  let attempt = 0

  for (;;) {
    attempt++
    const remaining = Math.max(0, deadline - Date.now())
    if (remaining === 0) return null

    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (r.ok) {
        const body = await r.json().catch(() => ({})) as { status?: string; stateSize?: number }
        if (body.status === "ok") {
          console.error(`Gateway ready on :${port} (stateSize=${body.stateSize ?? 0})`)
          return new HttpModel(`http://127.0.0.1:${port}`)
        }
        if (attempt === 1 || (attempt % 5 === 0)) {
          console.error(`Gateway on :${port} (status=${body.status ?? r.status}), retrying...`)
        }
      }
    } catch {
      if (attempt === 1 || (attempt % 5 === 0)) {
        console.error(`Gateway not yet reachable on :${port}, retrying...`)
      }
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, then cap at 16s
    const delay = Math.min(pollMs * Math.pow(2, attempt - 1), 16_000)
    await new Promise((r) => setTimeout(r, Math.min(delay, remaining)))
  }
}

async function runLive(baseDir: string, args: string[]): Promise<boolean> {
  console.error("── Live mode (envoy → storyteller) ──")

  const modelPath = EvalController.resolveModelPath(args)
  const gpu = EvalController.resolveGpu(args)
  const projectRoot = path.resolve(import.meta.dirname, "../..")

  console.error(`GPU: ${gpu}`)
  console.error(`Workspace: ${baseDir}`)

  // Auto-start gateway if not running
  let gatewayProc: import("child_process").ChildProcess | null = null
  let model = await tryConnectGateway()
  if (!model) {
    console.error("Starting gateway...")
    gatewayProc = spawn("pnpm", ["gateway"], {
      cwd: projectRoot,
      stdio: "pipe",
      detached: false,
      env: { ...process.env, NODE_ENV: "production" },
    })
    gatewayProc.stdout?.pipe(process.stdout)
    gatewayProc.stderr?.pipe(process.stderr)
    // Wait for gateway health
    model = await tryConnectGateway(void 0, { waitMs: 5 * 60 * 1000 })
    if (!model) {
      gatewayProc.kill()
      throw new Error("Gateway failed to start within 5 minutes")
    }
  }

  // Expose model + spawned gateway to signal handlers so SIGINT/SIGTERM can
  // forward an interrupt to the gateway and tear down spawned processes.
  activeModel = model
  activeGatewayProc = gatewayProc

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  // Fetch actual model name from gateway
  let modelName = path.basename(modelPath)
  try {
    const info = await model.modelInfo?.()
    if (info?.model) modelName = info.model
  } catch {}
  console.error(`Model: ${modelName}`)

  const trace = new TraceWriter("live").open({ mode: "live", model: modelName, gpu, workspace: baseDir })

  const envoy = await loadAgent("envoy")
  const storyteller = await loadAgent("storyteller")

  const controller = new EvalController({
    baseDir,
    model,
    sessionId: "envoy-dragons-live",
    trace,
  })

  const result = await controller.runAgentHierarchy({
    envoy,
    storyteller,
    userInput: USER_INPUT,
  })

  const storyDir = result.storyDir ? path.join(baseDir, "workspace", result.storyDir) : null

  // ── Live content validation: check actual model output format ──
  const envoyFormatErrors = EvalController.validateAssistantOutput(result.finalText)
  const stFormatErrors = EvalController.validateAssistantOutput(result.storytellerOutput)

  const checks: Check[] = [
    // Agent delegation
    { name: "envoy spawned agent", pass: result.subToolCalls >= 1 },
    { name: "envoy tool call format valid", pass: EvalController.validateToolCallFormat(result.finalText, envoy.toolDefs).length === 0 },
    // Workspace setup
    { name: "workspace dir exists", pass: fs.existsSync(baseDir) },
    { name: "story dir found", pass: result.storyDir !== null },
    // Planning
    { name: "plan file exists (_plan.md)", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "_plan.md")) },
    // Chapters
    { name: "at least 1 chapter", pass: controller.countChapterFiles(storyDir) >= 1 },
    { name: "at least 3 chapters", pass: controller.countChapterFiles(storyDir) >= 3 },
    // Wiki
    { name: "wiki character dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "character")) },
    { name: ">=1 character entry", pass: controller.countFilesInDir(storyDir, "wiki", "character") >= 1 },
    { name: "wiki location dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "location")) },
    { name: ">=1 location entry", pass: controller.countFilesInDir(storyDir, "wiki", "location") >= 1 },
    { name: "wiki faction dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "faction")) },
    { name: ">=1 faction entry", pass: controller.countFilesInDir(storyDir, "wiki", "faction") >= 1 },
    // Tool usage
    { name: "at least 1 tool call", pass: result.subToolCalls > 0 },
    { name: "storyteller tool call format valid", pass: EvalController.validateToolCallFormat(result.storytellerOutput, storyteller.toolDefs).length === 0 },
    { name: "tool responses traced", pass: result.toolResponseCount > 0 },
    // Example format (GBNF validation)
    { name: "envoy example format valid", pass: EvalController.validateExampleFormat(renderExamples("envoy"), envoy.toolDefs).length === 0 },
    { name: "storyteller example format valid", pass: EvalController.validateExampleFormat(renderExamples("storyteller"), storyteller.toolDefs).length === 0 },
    // Live output content validation
    { name: "envoy output format valid", pass: envoyFormatErrors.length === 0 },
    { name: "storyteller output format valid", pass: stFormatErrors.length === 0 },
  ]

  const allPass = EvalController.reportVerification("Live Verification", checks, trace)

  if (result.storyDir) {
    console.error(`\nStory files:`)
    controller.printTree(storyDir!)
  }

  trace.close()
  console.error(`\nTrace: ${trace.path}`)
  process.chdir(originalCwd)
  await model.dispose()
  if (gatewayProc) {
    gatewayProc.kill()
    console.error("Gateway stopped")
  }
  activeModel = null
  activeGatewayProc = null
  return allPass
}

// ── Main ──

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const isLive = args.includes("--live")
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-story-"))
  console.error(`Base dir: ${tmpDir}`)

  let success: boolean
  if (isLive) {
    const origCwd = process.cwd()
    try {
      success = await runLive(tmpDir, args)
    } catch (err) {
      console.error(`Live mode error: ${err instanceof Error ? err.message : String(err)}`)
      success = false
    } finally {
      // Always clear active references after runLive completes (success or error)
      // so an unexpected error doesn't leave the signal handler holding a stale
      // model. Active flags are also cleared inside runLive() when it exits
      // cleanly; this finally is the safety net.
      activeModel = null
      activeGatewayProc = null
      process.chdir(origCwd)
    }
    console.error(`\nFiles preserved: ${tmpDir}`)
  } else {
    success = await runOracle(tmpDir)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    console.error(`Cleaned up: ${tmpDir}`)
  }

  console.log(success ? "EVAL PASSED" : "EVAL FAILED")
  return success ? 0 : 1
}

async function sendInterrupt(sessionId = "envoy-dragons-live"): Promise<void> {
  if (!activeModel) return
  try {
    await activeModel.interrupt(sessionId)
    console.error(`[signal] interrupt forwarded to gateway session="${sessionId}"`)
  } catch (err) {
    console.error(`[signal] interrupt failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function killActiveGateway(): void {
  if (activeGatewayProc) {
    activeGatewayProc.kill()
    console.error("[signal] killed eval-spawned gateway")
  }
}

process.on("SIGINT", async () => {
  console.error("\nInterrupted")
  await sendInterrupt()
  killActiveGateway()
  process.exit(1)
})
process.on("SIGTERM", async () => {
  console.error("\nTerminated")
  await sendInterrupt()
  killActiveGateway()
  process.exit(1)
})

main().then((code) => process.exit(code)).catch(async (err) => {
  console.error("Eval error:", err)
  await sendInterrupt()
  killActiveGateway()
  process.exit(1)
})
