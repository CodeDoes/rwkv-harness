#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { MockModel } from "./mock-engine.ts"
import { toolHandlers as storytellerHandlers, toolDefs as storytellerToolDefs } from "../agents/storyteller/tools/index.ts"
import { toolDefs as envoyToolDefs, toolHandlers as envoyHandlers } from "../agents/envoy/tools/index.ts"
import type { Model, ToolDef } from "../types.ts"
import { RwkvModel } from "../model/rwkv-model.ts"
import mkdirTool from "../tools/mkdir.ts"
import { TraceWriter } from "./trace-writer.ts"
import { AgentLoop } from "../agent/loop.ts"
import { SessionManager } from "../session/session.ts"
import { loadExamples } from "./examples.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "../..")

// ── Shared utilities ──

function makeToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>\n`
}

function findStoryDir(baseDir: string): string | null {
  const workspace = path.join(baseDir, "workspace")
  try {
    for (const entry of fs.readdirSync(workspace)) {
      const full = path.join(workspace, entry)
      if (fs.statSync(full).isDirectory()) return entry
    }
  } catch { }
  return null
}

function countChapterFiles(storyDir: string | null): number {
  if (!storyDir) return 0
  try {
    return fs.readdirSync(storyDir).filter((f) => /^chapter/i.test(f)).length
  } catch { return 0 }
}

function countFilesInDir(storyDir: string | null, ...subdirs: string[]): number {
  if (!storyDir) return 0
  try {
    return fs.readdirSync(path.join(storyDir, ...subdirs)).filter((f) => f.endsWith(".md")).length
  } catch { return 0 }
}

function printTree(dir: string, prefix = "") {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry)
      const isDir = fs.statSync(full).isDirectory()
      console.error(`  ${prefix}${entry}${isDir ? "/" : ""}`)
      if (isDir) printTree(full, prefix + "  ")
    }
  } catch { }
}

function validateToolCallFormat(text: string, toolDefs: ToolDef[]): string[] {
  const errors: string[] = []
  const re = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g
  const validNames = new Set(toolDefs.map(t => t.name))
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(match[1])
    } catch {
      errors.push(`unparseable JSON in tool_call: ${match[1].slice(0, 60)}`)
      continue
    }
    if (typeof parsed.name !== "string" || !parsed.name) {
      errors.push(`tool_call missing "name" string field`)
      continue
    }
    if (!validNames.has(parsed.name as string)) {
      errors.push(`invalid tool name "${parsed.name}", valid: ${[...validNames].join(", ")}`)
    }
    if (!parsed.args || typeof parsed.args !== "object" || Array.isArray(parsed.args)) {
      errors.push(`tool_call "${parsed.name}" missing "args" object (has "arguments"? wrong format)`)
    }
  }
  return errors
}

interface Check { name: string; pass: boolean }

function reportVerification(label: string, checks: Check[], trace: TraceWriter): boolean {
  let passCount = 0
  console.error(`\n── ${label} ──`)
  for (const check of checks) {
    const status = check.pass ? "PASS" : "FAIL"
    console.error(`  [${status}] ${check.name}`)
    if (check.pass) passCount++
  }
  const allPass = passCount === checks.length
  console.error(`\n${passCount}/${checks.length} ${allPass ? "PASS" : "FAIL"}`)
  trace.verification(checks)
  return allPass
}

const ENVOY_EXAMPLES_TEXT = loadExamples("envoy")
const STORYTELLER_EXAMPLES_TEXT = loadExamples("storyteller")

const MKDR_TOOL_DEF: ToolDef = {
  name: "mkdir",
  description: "Create directory (recursive, no error if exists).",
  parameters: [
    { name: "path", type: "string", description: "Directory path", required: true },
  ],
}

const USER_INPUT = "Create a story about dragons with 3 first chapters and an up-to-date wiki."

// ── Shared agent hierarchy runner ──

interface RunnerConfig {
  model: Model
  baseDir: string
  sessionId: string
  trace: TraceWriter
  envoyPrompt: string
  examples: string
  bakeEnvoyExamples?: () => Promise<void>
  bakeStorytellerExamples?: () => Promise<void>
  onSpawnResult?: (args: Record<string, unknown>, subResult: string, storySession: SessionManager) => Record<string, unknown>
}

async function runAgentHierarchy(cfg: RunnerConfig): Promise<{
  finalText: string
  subToolCalls: number
  storyDir: string | null
  storytellerOutput: string
}> {
  let subToolCalls = 0
  let storytellerOutput = ""
  const { model, baseDir, sessionId, trace, envoyPrompt, examples, bakeEnvoyExamples, bakeStorytellerExamples, onSpawnResult } = cfg

  if (bakeEnvoyExamples) await bakeEnvoyExamples()

  trace.inputBlock(envoyPrompt + "\n\nUser: " + USER_INPUT + "\n\nAssistant:")
  trace.outputBlock()

  const session = new SessionManager(baseDir, sessionId, "envoy")
  await session.ensureDir()

  const agentLoop = new AgentLoop(model, session, 1, {
    systemPrompt: envoyPrompt,
    examples,
    toolDefs: envoyToolDefs,
    onToolResult: (result) => trace.toolResultBlock(result),
    toolHandlers: {
      ...envoyHandlers,
      spawn_agent: async (args) => {
        const agentName = args.agent as string
        const workspacePath = `workspace/${agentName}-${Date.now().toString(36)}`
        const task = `${USER_INPUT} Write files to ${workspacePath}`
        trace.infoSection("spawn_agent: storyteller")
        trace.infoAbout("task", { description: task })
        trace.infoAbout("workspace", { path: workspacePath })
        console.error(`\nENVOY spawned "${agentName}"`)

        await model.saveCheckpoint("envoy-pause")
        if (bakeStorytellerExamples) await bakeStorytellerExamples()
        await model.loadCheckpoint("fewshot-storyteller")

        const instructions = `You are a writer. Use tools: mkdir, write. Write _plan.md first, then 3 short chapters as chapter-NNN.md, then wiki/character/, wiki/location/, wiki/faction/ dirs with .md files. Keep chapter content brief (2-3 sentences).`

        const storySession = new SessionManager(
          session.sessionDirPath,
          workspacePath,
          "storyteller",
        )
        await storySession.ensureDir()

        const subLoop = new AgentLoop(model, storySession, 15, {
          systemPrompt: instructions,
          examples: "",
          toolDefs: [...storytellerToolDefs, MKDR_TOOL_DEF],
          toolHandlers: {
            ...storytellerHandlers,
            mkdir: (margs: Record<string, unknown>) => mkdirTool({ path: margs.path as string }),
          },
          onToolCall: (name) => {
            subToolCalls++
            console.error(`  STORYTELLER depth: tool "${name}"`)
          },
          onToolResult: (result) => trace.toolResultBlock(result),
        })

        trace.infoSection("storyteller sub-loop")
        let subFirst = true
        const subResult = await subLoop.run(task, {
          onRawOutput: (raw) => {
            if (!subFirst) trace.outputBlock()
            subFirst = false
            trace.outputStream(raw)
          },
          onText: (t: string) => {
            process.stdout.write(t)
            storytellerOutput += t
          },
        }, { maxTokens: 500, temperature: 0.5 })

        trace.infoSection("summarization")
        const summaryPrompt = `\n\nUser: List the files you created.\n\nAssistant: I created files at`
        const summaryRaw = await model.generate(summaryPrompt, {
          temperature: 0.3,
          maxTokens: 100,
          stopSequences: ["\n\n", "\x03"],
        })
        const report = summaryRaw.replace(/\x03/g, "").trim()
        trace.outputBlock()
        trace.outputStream(report)

        await model.loadCheckpoint("envoy-pause")

        const extra = onSpawnResult ? onSpawnResult(args, subResult, storySession) : {}
        return { summary: report, sessionId: storySession.sessionIdStr, ...extra }
      },
    },
    onToolCall: (name) => {
      if (name !== "spawn_agent") {
        subToolCalls++
        console.error(`  depth: tool "${name}"`)
      }
    },
  })

  let firstOutput = true
  const finalText = await agentLoop.run(USER_INPUT, {
    onRawOutput: (raw) => {
      if (!firstOutput) trace.outputBlock()
      firstOutput = false
      trace.outputStream(raw)
    },
    onText: (t: string) => process.stdout.write(t),
  }, { maxTokens: 300 })

  const storyDir = findStoryDir(baseDir)
  return { finalText, subToolCalls, storyDir: storyDir ? path.basename(storyDir) : null, storytellerOutput }
}

// ── Oracle content ──

const PLAN_CONTENT = `# The Dragon's Legacy\n\nStory plan for dragon story.\n`
const CH1_CONTENT = `# Chapter 1: The Awakening\n\nChapter 1 content.\n`
const CH2_CONTENT = `# Chapter 2: The Flight\n\nChapter 2 content.\n`
const CH3_CONTENT = `# Chapter 3: The Hoard\n\nChapter 3 content.\n`
const WIKI_ERYNDOR = `# Eryndor\n\nCharacter: Eryndor the bronze dragon.\n`
const WIKI_DRAGON_PEAK = `# Dragon's Peak\n\nLocation: Dragon's Peak.\n`
const WIKI_EMERALD_CLAW = `# Emerald Claw\n\nFaction: The Emerald Claw.\n`

// ── Oracle mode ──

async function runOracle(baseDir: string): Promise<boolean> {
  console.error("── Oracle mode (envoy → storyteller) ──")
  const storyPath = "workspace/dragons"
  const jobTask = `${USER_INPUT} Write files to ${storyPath}`

  const trace = new TraceWriter("oracle").open()
  trace.infoAbout("run", { mode: "oracle", baseDir })

  const mockResponses = [
    `I'll delegate this to the storyteller.\n` + makeToolCall("spawn_agent", { agent: "storyteller", task: jobTask, workspace: storyPath }),
    `Let me check what exists first.\n` + makeToolCall("ls", { path: "workspace" }),
    `Setting up story directory.\n` + makeToolCall("mkdir", { path: "workspace/dragons" }),
    `Writing plan.\n` + makeToolCall("write", { path: "workspace/dragons/_plan.md", content: PLAN_CONTENT }),
    `Chapter 1.\n` + makeToolCall("write", { path: "workspace/dragons/chapter-001.md", content: CH1_CONTENT }),
    `Chapter 2.\n` + makeToolCall("write", { path: "workspace/dragons/chapter-002.md", content: CH2_CONTENT }),
    `Chapter 3.\n` + makeToolCall("write", { path: "workspace/dragons/chapter-003.md", content: CH3_CONTENT }),
    `Wiki character dir.\n` + makeToolCall("mkdir", { path: "workspace/dragons/wiki/character" }),
    makeToolCall("write", { path: "workspace/dragons/wiki/character/eryndor.md", content: WIKI_ERYNDOR }),
    makeToolCall("mkdir", { path: "workspace/dragons/wiki/location" }),
    makeToolCall("write", { path: "workspace/dragons/wiki/location/dragon-peak.md", content: WIKI_DRAGON_PEAK }),
    makeToolCall("mkdir", { path: "workspace/dragons/wiki/faction" }),
    makeToolCall("write", { path: "workspace/dragons/wiki/faction/emerald-claw.md", content: WIKI_EMERALD_CLAW }),
    `Done! All chapters and wiki entries created.`,
    `Created _plan.md, chapter-001.md, chapter-002.md, chapter-003.md, wiki/character/eryndor.md, wiki/location/dragon-peak.md, wiki/faction/emerald-claw.md`,
  ]

  const model = new MockModel(mockResponses)
  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const envoyPrompt = await fs.promises.readFile(
    path.join(PROJECT_ROOT, "src/agents/envoy/instructions.mdx"),
    "utf-8",
  )

  const result = await runAgentHierarchy({
    model,
    baseDir,
    sessionId: "envoy-dragons-oracle",
    trace,
    envoyPrompt,
    examples: ENVOY_EXAMPLES_TEXT,
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

  const envoyToolErr = validateToolCallFormat(mockResponses[0], envoyToolDefs)
  const stDefs = [...storytellerToolDefs, MKDR_TOOL_DEF]
  const stErrors: string[] = []
  for (let i = 1; i <= 12; i++) stErrors.push(...validateToolCallFormat(mockResponses[i], stDefs))

  const checks: Check[] = [
    { name: "workspace dir", pass: fs.existsSync("workspace") && fs.statSync("workspace").isDirectory() },
    { name: "story dir", pass: fs.existsSync("workspace/dragons") },
    { name: "plan file", pass: fs.existsSync("workspace/dragons/_plan.md") },
    { name: "chapter 1", pass: fs.existsSync("workspace/dragons/chapter-001.md") },
    { name: "chapter 2", pass: fs.existsSync("workspace/dragons/chapter-002.md") },
    { name: "chapter 3", pass: fs.existsSync("workspace/dragons/chapter-003.md") },
    { name: "wiki character dir", pass: fs.existsSync("workspace/dragons/wiki/character") },
    { name: "character entry", pass: fs.existsSync("workspace/dragons/wiki/character/eryndor.md") },
    { name: "wiki location dir", pass: fs.existsSync("workspace/dragons/wiki/location") },
    { name: "location entry", pass: fs.existsSync("workspace/dragons/wiki/location/dragon-peak.md") },
    { name: "wiki faction dir", pass: fs.existsSync("workspace/dragons/wiki/faction") },
    { name: "faction entry", pass: fs.existsSync("workspace/dragons/wiki/faction/emerald-claw.md") },
    { name: "plan content correct", pass: fs.readFileSync("workspace/dragons/_plan.md", "utf-8") === PLAN_CONTENT },
    { name: "ch1 content correct", pass: fs.readFileSync("workspace/dragons/chapter-001.md", "utf-8") === CH1_CONTENT },
    { name: "ch2 content correct", pass: fs.readFileSync("workspace/dragons/chapter-002.md", "utf-8") === CH2_CONTENT },
    { name: "ch3 content correct", pass: fs.readFileSync("workspace/dragons/chapter-003.md", "utf-8") === CH3_CONTENT },
    { name: "wiki eryndor correct", pass: fs.readFileSync("workspace/dragons/wiki/character/eryndor.md", "utf-8") === WIKI_ERYNDOR },
    { name: "wiki dragon-peak correct", pass: fs.readFileSync("workspace/dragons/wiki/location/dragon-peak.md", "utf-8") === WIKI_DRAGON_PEAK },
    { name: "wiki emerald-claw correct", pass: fs.readFileSync("workspace/dragons/wiki/faction/emerald-claw.md", "utf-8") === WIKI_EMERALD_CLAW },
    { name: "envoy returned text", pass: result.finalText.length > 0 },
    { name: "storyteller made all 12 tool calls", pass: result.subToolCalls === 12 },
    { name: "all mock responses consumed", pass: model.callCount === mockResponses.length },
    { name: "envoy tool call format valid", pass: envoyToolErr.length === 0 },
    { name: "storyteller tool calls format valid", pass: stErrors.length === 0 },
  ]

  const allPass = reportVerification("Oracle Verification", checks, trace)
  trace.close()
  console.error(`\nTrace: ${trace.path}`)
  process.chdir(originalCwd)
  return allPass
}

// ── Live mode ──

async function runLive(baseDir: string, args: string[]): Promise<boolean> {
  console.error("── Live mode (envoy → storyteller) ──")

  const modelPath = args.find((a) => a.startsWith("--model="))?.split("=")[1]
    || path.join(PROJECT_ROOT, "models/rwkv7-g1g-2.9b-20260526-ctx8192.gguf")
  const gpu = (args.find((a) => a.startsWith("--gpu="))?.split("=")[1] || "vulkan") as "vulkan" | "cuda" | "auto"

  console.error(`Model: ${path.basename(modelPath)}`)
  console.error(`GPU: ${gpu}`)
  console.error(`Workspace: ${baseDir}`)

  const model = new RwkvModel(modelPath, baseDir)
  await model.init(gpu)

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const trace = new TraceWriter("live").open()
  const infoData: Record<string, string> = { model: path.basename(modelPath), gpu, workspace: baseDir }
  if (model.loraAdapters.length) infoData.lora = model.loraAdapters.map(a => a.filePath).join(", ")
  infoData.mose = "none"
  trace.infoAbout("run", infoData)

  const result = await runAgentHierarchy({
    model,
    baseDir,
    sessionId: "envoy-dragons-live",
    trace,
    envoyPrompt: `You are the envoy. Delegate story writing to the storyteller agent using spawn_agent with agent="storyteller". Spawn only ONCE. After the agent finishes, say "Done." Keep responses short.`,
    examples: "",
    bakeEnvoyExamples: async () => {
      await model.saveCheckpoint("_clean")
      await model.evaluate(ENVOY_EXAMPLES_TEXT)
      await model.saveCheckpoint("fewshot-envoy")
    },
    bakeStorytellerExamples: async () => {
      await model.loadCheckpoint("_clean")
      await model.evaluate(STORYTELLER_EXAMPLES_TEXT)
      await model.saveCheckpoint("fewshot-storyteller")
    },
  })

  const storyName = result.storyDir ?? "(not found)"
  const storyFull = result.storyDir ? path.join(baseDir, "workspace", result.storyDir) : null
  const checks: Check[] = [
    { name: `workspace dir exists`, pass: fs.existsSync(baseDir) },
    { name: `story dir found (${storyName})`, pass: result.storyDir !== null },
    { name: "plan file exists (_plan.md)", pass: storyFull !== null && fs.existsSync(path.join(storyFull, "_plan.md")) },
    { name: "at least 1 chapter", pass: countChapterFiles(storyFull) >= 1 },
    { name: "at least 3 chapters", pass: countChapterFiles(storyFull) >= 3 },
    { name: "wiki character dir", pass: storyFull !== null && fs.existsSync(path.join(storyFull, "wiki", "character")) },
    { name: ">=1 character entry", pass: countFilesInDir(storyFull, "wiki", "character") >= 1 },
    { name: "wiki location dir", pass: storyFull !== null && fs.existsSync(path.join(storyFull, "wiki", "location")) },
    { name: ">=1 location entry", pass: countFilesInDir(storyFull, "wiki", "location") >= 1 },
    { name: "wiki faction dir", pass: storyFull !== null && fs.existsSync(path.join(storyFull, "wiki", "faction")) },
    { name: ">=1 faction entry", pass: countFilesInDir(storyFull, "wiki", "faction") >= 1 },
    { name: "envoy returned text", pass: result.finalText.length > 0 },
    { name: "at least 1 tool call", pass: result.subToolCalls > 0 },
    { name: "envoy tool call format valid", pass: validateToolCallFormat(result.finalText, envoyToolDefs).length === 0 },
    { name: "storyteller tool call format valid", pass: validateToolCallFormat(result.storytellerOutput, [...storytellerToolDefs, MKDR_TOOL_DEF]).length === 0 },
  ]

  const allPass = reportVerification("Live Verification", checks, trace)

  if (result.storyDir) {
    console.error(`\nStory files:`)
    printTree(storyFull!)
  }

  trace.close()
  console.error(`\nTrace: ${trace.path}`)
  process.chdir(originalCwd)
  await model.dispose()
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
    try {
      success = await runLive(tmpDir, args)
    } catch (err) {
      console.error(`Live mode error: ${err instanceof Error ? err.message : String(err)}`)
      success = false
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

main().then((code) => process.exit(code)).catch((err) => {
  console.error("Eval error:", err)
  process.exit(1)
})
