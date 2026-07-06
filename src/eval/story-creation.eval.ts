#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { EvalController, type Check } from "./eval-controller.ts"
import { loadAgent } from "../agents/agent-loader.ts"
import { renderExamples, renderAssistantTurn } from "../agents/examples.ts"
import type { ExampleEntry } from "../agents/example-template.ts"
import type { ToolDef, Engine } from "../types.ts"

import { NativeRwkvModel } from "../model/native-rwkv-model.ts"
import { HttpModel } from "../model/http-model.ts"
import { SessionHost } from "../session/session-host.ts"
import { GatewayServer } from "../gateway/server.ts"
import { TraceWriter } from "./trace-writer.ts"
import { LogStream } from "../core/log-stream.ts"
import { resolveWorkspace, workspaceModeFromEnv, type WorkspaceMode } from "../core/workspace.ts"

// Eval-wide progress mirror → both stderr AND `.eval.log` on disk so
// `pnpm eval:logs` / `pnpm eval:tail-logs` can surface partial output.
const ELOG_PATH = path.resolve(process.cwd(), ".eval.log")
const elog = new LogStream({ path: ELOG_PATH, mirror: "stderr", prefix: "" })
function eLog(msg: string): void {
  elog.line(msg)
}
eLog(`[eval] start pid=${process.pid} cwd=${process.cwd()}`)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Active model reference shared with signal handlers so Ctrl+C can
// interrupt in-flight generation before exit.
let activeModel: Engine | null = null

const USER_INPUT = "Create a story about dragons with 3 first chapters and an up-to-date wiki."

// ── Oracle content ──

const PLAN_SEGMENT = `# The Dragon's Legacy\n\nA young blacksmith discovers a dying dragon and must choose between saving it and protecting his village.\n\n## Chapters\n1. The Discovery\n2. The Bond\n3. The Sacrifice\n\n## Wiki\n- Character: Lyra (dragon), Kael (blacksmith)\n- Location: Emberhold village, Dragon's Peak\n- Faction: The Ashen Council\n`
/** Long plan content that triggers max_length truncation in the mock */
const PLAN_CONTENT = Array.from({ length: 8 }, () => PLAN_SEGMENT).join("\n\n")
const CH1_CONTENT = `# Chapter 1: The Discovery\n\nThe forge fire hissed as Kael plunged the red-hot steel into the water. A shadow crossed the window. He looked up and saw nothing but dark trees swaying in the wind. Then he heard it: a low, rumbling moan that seemed to shake the very ground beneath his feet.\n\nHe grabbed his lantern and stepped outside. The sound grew louder, and with it came a faint orange glow from behind the ridge. Kael climbed the rocky path, his heart pounding. At the top, he froze.\n\nA massive creature lay crumpled in the ravine, its bronze scales cracked and oozing. One eye opened slowly, fixing him with a gaze that was both fierce and pleading. Kael whispered, \"You are real.\" The dragon let out a soft whimper. \"Help me,\" she breathed. \"Please.\"\n`
const CH2_CONTENT = `# Chapter 2: The Bond\n\nKael brought water from the stream. The dragon drank, her breathing steadying. He sat beside her, watching the stars emerge. \"What is your name?\" he asked. The dragon turned her head. \"Lyra,\" she said. \"I am the last of my kind. The Ashen Council hunted us down one by one.\"\n\nKael built a fire. Lyra told him of the old world, when dragons ruled the skies and humans lived in awe beneath them. \"They fear what they do not understand,\" Kael said. Lyra nodded. \"And fear makes people cruel.\"\n\nIn the days that followed, Kael tended to Lyra's wounds. She grew stronger. He climbed onto her back, and she spread her wings for the first time in months. The wind rushed past them as they soared above the village. Kael shouted with joy.\n`
const CH3_CONTENT = `# Chapter 3: The Sacrifice\n\nThe Ashen Council arrived at dawn. Three figures in gray cloaks stood at the village gate. \"We know you harbor a dragon,\" the leader said. \"Hand it over, or the village burns.\"\n\nKael stood before them. \"She is not a thing to hand over. She is my friend.\" The leader sneered. \"Then you will burn with her.\"\n\nLyra emerged from the ridge, her scales gleaming in the morning light. She spread her wings and roared. The council stumbled back. \"You wish to fight?\" Lyra said. \"I have no fight left in me. I offer myself. Let the boy go.\"\n\nThey took her away in iron chains. Kael watched until she disappeared over the horizon. That night, he found a single bronze scale lying on his doorstep. He held it tight and whispered, \"I will find you.\"\n`
const WIKI_ERYNDOR = `# Lyra\n\n**Role:** Bronze dragon, last of her kind\n**Age:** 427 years\n**Appearance:** Bronze scales, golden eyes, wingspan of 30 feet\n**Personality:** Wise, weary, fiercely protective of those she trusts\n**Backstory:** Lyra watched her entire species hunted by the Ashen Council. She fled to the mountains near Emberhold, where her injuries finally caught up with her. Kael found her and nursed her back to health, forging an unlikely bond.\n`
const WIKI_DRAGON_PEAK = `# Dragon's Peak\n\n**Location:** Mountain range east of Emberhold\n**Description:** The highest peak in the region, named for the dragons that once nested there. The summit is perpetually shrouded in mist, and the caves beneath hold ancient dragon-carved tunnels. The locals say that on quiet nights, you can still hear the echo of dragon songs.\n`
const WIKI_EMERALD_CLAW = `# The Ashen Council\n\n**Type:** Anti-dragon faction\n**Leader:** Councillor Maren\n**Headquarters:** The Ivory Tower, capital city\n**Goal:** Eliminate all remaining dragons from the realm\n**Methods:** Use of ash-magic that suppresses dragon fire. Trackers with enchanted compasses that point toward dragon blood. Bounty hunters paid per scale delivered to the council vault.\n`

// ── Embedded gateway helper ──

/**
 * Wrap any Engine behind an in-process GatewayServer + HttpModel so the
 * eval exercises the full HTTP/oRPC pipeline even with a mock engine.
 * Gateway listens on a random port to avoid conflicts.
 */
async function startEmbeddedGateway(
  engine: Engine,
  stateDir: string,
  modelPath: string,
): Promise<{ model: HttpModel; server: GatewayServer; cleanup: () => Promise<void> }> {
  const host = new SessionHost(engine, stateDir)
  await host.init()
  const server = new GatewayServer(host, undefined, modelPath)
  await server.start(0)
  server.markReady()
  const addr = server.getHttpServer().address()
  const port = typeof addr === "string" ? parseInt(addr.split(":").pop()!, 10) : addr!.port
  const model = new HttpModel(`http://127.0.0.1:${port}`)
  return {
    model,
    server,
    cleanup: async () => {
      await model.dispose()
      await server.stop()
      await engine.dispose()
    },
  }
}

// ── Oracle mode ──

async function runOracle(baseDir: string): Promise<boolean> {
  console.error("── Oracle mode (envoy → storyteller) ──")
  const storyPath = "workspace/dragons"
  const jobTask = `${USER_INPUT} Write files to ${storyPath}`

const trace = new TraceWriter("oracle", { tracesDir: path.resolve(__dirname, ".traces") }).open({ mode: "oracle", baseDir })

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

  // Use a low truncation limit so the plan write (long content) hits
  // max_length mid-tool-call, testing the continuation path.
  const engine = EvalController.createMockModel(mockResponses, 1000)
  const { model, cleanup: gwCleanup } = await startEmbeddedGateway(
    engine,
    path.join(baseDir, "_gateway"),
    "mock",
  )

  const envoy = await loadAgent("envoy")
  const storyteller = await loadAgent("storyteller")

  // Workspace placement: resolved via core/workspace.ts so eval defaults
  // to `temp` (auto-named under .tmp/workspace/) and CLI / live
  // commands can opt into `live` with --workspace=live.
  const mode = workspaceModeFromEnv(process.env, process.argv.slice(2))
  const ws = resolveWorkspace({ mode, slug: "dragons-oracle", baseDir })
  const controller = new EvalController({
    baseDir,
    model,
    sessionId: "envoy-dragons-oracle",
    trace,
    workspaceRoot: ws.path,
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

  // Per-block lenient grammar validation — each mock response must conform
  // to the grammar-level contract (balanced tags, no role echoes, valid JSON).
  const envoyBlockErr = EvalController.validateAssistantOutputLenient(mockResponses[0])
  const stBlockErrs: string[] = []
  for (let i = 1; i < mockResponses.length; i++) {
    stBlockErrs.push(...EvalController.validateAssistantOutputLenient(mockResponses[i]))
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
    { name: "all mock responses consumed", pass: engine.callCount >= mockResponses.length },
    { name: "max_length continuation exercised", pass: engine.callCount > mockResponses.length },
    { name: "envoy tool call format valid", pass: envoyToolErr.length === 0 },
    { name: "storyteller tool calls format valid", pass: stErrors.length === 0 },
    { name: "envoy grammar valid", pass: envoyGrammarErr === null },
    { name: "storyteller grammar valid", pass: stGrammarErr === null },
    { name: "envoy block grammar valid (lenient)", pass: envoyBlockErr.length === 0 },
    { name: "storyteller blocks grammar valid (lenient)", pass: stBlockErrs.length === 0 },
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
  await gwCleanup()
  return allPass
}

// ── Live mode ──

async function runLive(baseDir: string, args: string[]): Promise<boolean> {
  console.error("── Live mode (envoy → storyteller) ──")

  const modelPath = EvalController.resolveModelPath(args)
  const gpu = EvalController.resolveGpu(args)
  console.error(`GPU: ${gpu}`)
  console.error(`Workspace: ${baseDir}`)

  // Embedded gateway: NativeRwkvModel behind GatewayServer + HttpModel.
  // Same pipeline as oracle, just with the real model as the engine.
  console.error("Loading native model...")
  const stateDir = path.join(baseDir, "_gateway")
  const engine = new NativeRwkvModel(modelPath, stateDir)
  await engine.init(gpu)
  const gw = await startEmbeddedGateway(engine, stateDir, modelPath)
  const model = gw.model
  activeModel = model

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const modelName = path.basename(modelPath)
  console.error(`Model: ${modelName}`)

  const trace = new TraceWriter("live", { tracesDir: path.resolve(__dirname, ".traces") }).open({ mode: "live", model: modelName, gpu, workspace: baseDir })

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

  // ── Live content validation: use LENIENT (grammar-level) checks.
  // Strict-level drift detection is reserved for example rendering
  // (see the "static oracle format-validation" tests below).
  const envoyFormatErrors = EvalController.validateAssistantOutputLenient(result.finalText)
  const stFormatErrors = EvalController.validateAssistantOutputLenient(result.storytellerOutput)

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
  await gw.cleanup()
  activeModel = null
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
      // Clear the model reference so the signal handler doesn't hold a
      // stale object after unexpected errors.
      activeModel = null
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

// Signal handlers just interrupt any in-flight generation, then exit.
// Embedded gateway cleanup happens in runLive() — these handlers are
// for Ctrl-C during generation.
process.on("SIGINT", async () => {
  console.error("\nInterrupted")
  await sendInterrupt()
  process.exit(1)
})
process.on("SIGTERM", async () => {
  console.error("\nTerminated")
  await sendInterrupt()
  process.exit(1)
})

main().then((code) => process.exit(code)).catch(async (err) => {
  console.error("Eval error:", err)
  await sendInterrupt()
  process.exit(1)
})
