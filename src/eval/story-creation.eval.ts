#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { MockModel } from "./mock-engine.ts"
import { toolHandlers as storytellerHandlers, toolDefs as storytellerToolDefs } from "../agents/storyteller/tools/index.ts"
import { toolDefs as envoyToolDefs } from "../agents/envoy/tools/index.ts"
import { ToolCall, ToolResult, ToolDef, ToolHandler, DEFAULT_GEN_OPTS, type Model } from "../types.ts"
import { bootRemoteModel, HttpModel } from "../model/http-model.ts"
import mkdirTool from "../tools/mkdir.ts"
import { TraceWriter } from "./trace-writer.ts"
import { toolsToGbnfWithThink } from "../tools/registry.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "../..")

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>\n`
}

function parseToolCalls(text: string): { text: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = []
  const segments: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  const re = new RegExp(TOOL_CALL_RE.source, "g")
  while ((match = re.exec(text)) !== null) {
    segments.push(text.slice(lastIndex, match.index))
    lastIndex = re.lastIndex
    try {
      const parsed = JSON.parse(match[1])
      toolCalls.push({ name: parsed.name, args: parsed.args ?? {} })
    } catch {
      segments.push(match[0])
    }
  }
  segments.push(text.slice(lastIndex))
  return { text: segments.join("").trim(), toolCalls }
}

function formatToolResult(result: ToolResult): string {
  const body = JSON.stringify(result.data ?? null)
  const label = `<tool_result name="${result.name}" success="${result.success}">`
  if (result.error) {
    return `${label}\nerror: ${result.error}\n</tool_result>`
  }
  const truncated = body.length > 2000 ? body.slice(0, 2000) + "..." : body
  return `${label}\n${truncated}\n</tool_result>`
}

function toolsToXml(defs: ToolDef[]): string {
  return defs.map((t) => {
    const params = t.parameters.map((p) =>
      `  <parameter name="${p.name}" type="${p.type}"${p.required ? ' required="true"' : ""}${p.enum ? ` enum="${p.enum.join(",")}"` : ""}>${p.description}</parameter>`
    ).join("\n")
    return `<tool name="${t.name}" description="${t.description}">\n${params}\n</tool>`
  }).join("\n\n")
}

// ──────────────────────────────────────────────
// Agent loop engine
// ──────────────────────────────────────────────

async function runAgentLoop(
  engine: MockModel | Model,
  systemPrompt: string,
  toolHandlers: Record<string, ToolHandler>,
  userInput: string,
  maxDepth: number,
  opts?: {
    onToolCall?: (name: string, success: boolean) => void
    trace?: TraceWriter
    tag?: string
    genOpts?: Record<string, unknown>
    onText?: (text: string) => void
  },
): Promise<{ finalText: string; toolCallCount: number }> {
  // RWKV7 function calling format: System: ... User: ... Assistant: ...
  // Temp 0, top_p 0, penalty 0 for function calling per HF guide
  let fullPrompt = systemPrompt + "\n\nUser: " + userInput + "\n\nAssistant:"
  let finalText = ""
  let toolCallCount = 0
  const { onToolCall, trace, tag, genOpts } = opts ?? {}

  for (let depth = 0; depth < maxDepth; depth++) {
    const depthLabel = tag ? `depth ${depth} (${tag})` : `depth ${depth}`
    trace?.infoSection(depthLabel)
    trace?.infoAbout("input", { chars: String(fullPrompt.length) })

    let raw: string
    if ("generateStream" in engine) {
      let accumulated = ""
      await engine.generateStream(fullPrompt, {
        onText: (chunk: string) => {
          accumulated += chunk
          trace?.outputStream(chunk)
          process.stdout.write(chunk)
        },
      }, { ...DEFAULT_GEN_OPTS, temperature: 0, topP: 0, repeatPenalty: 0, stopSequences: ["\n\n\x03", "</tool_call>"], ...genOpts } as any)
      raw = accumulated.replace(/\x03/g, "")
      opts?.onText?.(raw)
    } else {
      raw = (await engine.generate(fullPrompt, { ...DEFAULT_GEN_OPTS, temperature: 0, topP: 0, repeatPenalty: 0, stopSequences: ["\n\n\x03", "</tool_call>"], ...genOpts } as any)).replace(/\x03/g, "")
      trace?.infoSection("output")
      trace?.outputStream(raw)
      opts?.onText?.(raw)
    }

    const { text, toolCalls } = parseToolCalls(raw)
    finalText += text

    if (toolCalls.length === 0) {
      trace?.infoAbout("result", { status: "no tool calls, exiting loop" })
      return { finalText, toolCallCount }
    }

    for (const call of toolCalls) {
      toolCallCount++
      trace?.infoAbout("tool_call", { name: call.name, args: JSON.stringify(call.args) })
      const handler = toolHandlers[call.name]
      let result: ToolResult
      if (!handler) {
        result = { name: call.name, success: false, data: null, error: `Unknown tool: ${call.name}` }
      } else {
        try {
          const data = await handler(call.args)
          result = { name: call.name, success: true, data, error: undefined }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          result = { name: call.name, success: false, data: null, error: msg }
        }
      }
      onToolCall?.(call.name, result.success)
      const resultInfo: Record<string, string> = { name: call.name, success: String(result.success) }
      if (result.error) resultInfo.error = result.error
      trace?.infoAbout("tool_result", resultInfo)
      const resultBlock = formatToolResult(result)
      fullPrompt += raw + "\n\nUser: " + resultBlock + "\n\nAssistant:"
    }
  }

  return { finalText, toolCallCount }
}

// ──────────────────────────────────────────────
// System prompt builder
// ──────────────────────────────────────────────

function buildEnvoyPrompt(): string {
  const toolXml = toolsToXml(envoyToolDefs)
  return `System: You are the envoy — the user's direct point of contact. You do not perform tasks yourself. Instead, you delegate work to specialized agents.

Available agents:
- storyteller: Creative writing, story planning, worldbuilding wiki entries
- coder: Code writing, editing, file system operations

When the user asks for something, use spawn_agent to delegate to the right agent. Always include the full task description.

Tools:
${toolXml}

Examples:

User: Write a program to sort a list
Assistant: Let me delegate this to the coder agent.

<tool_call>
{"name": "spawn_agent", "args": {"agent": "coder", "task": "Write a program to sort a list. Write files to workspace/sort/"}}
</tool_call>

User: Create a story about a wizard
Assistant: I'll delegate this to the storyteller.

<tool_call>
{"name": "spawn_agent", "args": {"agent": "storyteller", "task": "Create a story about a wizard. Write files to workspace/wizard-tale/"}}
</tool_call>`
}

function buildStorytellerPrompt(defs: ToolDef[]): string {
  const toolXml = toolsToXml(defs)
  return `System: You are a creative writing AI assistant. You write compelling fiction with rich worldbuilding, consistent character development, and engaging plots.

Core rules:
- Write proactively. Do not ask questions.
- Maintain consistent tone, POV, and tense throughout.
- Show, don't tell. Use sensory details, dialogue, and action.
- Each chapter section should advance plot, develop character, or deepen worldbuilding.
- Track word counts. Chapter sections target 400-800 words.

You can use tools to read and write files. When you need to use a tool, output:

<tool_call>
{"name": "tool_name", "args": { ... }}
</tool_call>

Then I'll run the tool and give you the result.

Tools:
${toolXml}

Story Creation Workflow:
When asked to create a story with chapters and wiki, follow these exact steps:

Step 1 — Check workspace: ls workspace/
Step 2 — Create story directory: mkdir workspace/<story-name>/
Step 3 — Write story plan: write workspace/<story-name>/_plan.md
Step 4 — Write each chapter: write workspace/<story-name>/chapter-NNN.md
Step 5 — Create wiki dirs: mkdir workspace/<story-name>/wiki/character/ , mkdir workspace/<story-name>/wiki/location/ , mkdir workspace/<story-name>/wiki/faction/
Step 6 — Write wiki entries (one per file) for characters, locations, factions
Step 7 — Quality check: story-analyze then story-validate as needed

Use exact paths. Write one file at a time. Announce completion when all files are created.

Examples:

User: create a story about a wizard
Assistant: Let me check what exists first.

<tool_call>
{"name": "ls", "args": {"path": "workspace"}}
</tool_call>

User: <tool_result name="ls" success="true">
[]
</tool_result>

Assistant: The workspace is empty. I'll set up the story directory.

<tool_call>
{"name": "mkdir", "args": {"path": "workspace/wizard-tale"}}
</tool_call>

User: <tool_result name="mkdir" success="true">
{"success":true}
</tool_result>

Assistant: Now I'll write the story plan.

<tool_call>
{"name": "write", "args": {"path": "workspace/wizard-tale/_plan.md", "content": "# The Wizard's Apprentice\n\n..."}}
</tool_call>`
}

// ──────────────────────────────────────────────
// Oracle story content (short placeholders)
// ──────────────────────────────────────────────

const PLAN_CONTENT = `# The Dragon's Legacy\n\nStory plan for dragon story.\n`
const CH1_CONTENT = `# Chapter 1: The Awakening\n\nChapter 1 content.\n`
const CH2_CONTENT = `# Chapter 2: The Flight\n\nChapter 2 content.\n`
const CH3_CONTENT = `# Chapter 3: The Hoard\n\nChapter 3 content.\n`
const WIKI_ERYNDOR = `# Eryndor\n\nCharacter: Eryndor the bronze dragon.\n`
const WIKI_DRAGON_PEAK = `# Dragon's Peak\n\nLocation: Dragon's Peak.\n`
const WIKI_EMERALD_CLAW = `# Emerald Claw\n\nFaction: The Emerald Claw.\n`

// ──────────────────────────────────────────────
// Oracle mode — tests envoy → storyteller chain
// ──────────────────────────────────────────────

async function runOracle(baseDir: string, W: (p: string) => string): Promise<boolean> {
  console.error("── Oracle mode (envoy → storyteller) ──")

  const storyPath = W("workspace/dragons")
  const jobTask = `Create a story about dragons with 3 first chapters and an up-to-date wiki. Write files to ${storyPath}`

  // Build mock responses:
  //   Phase A (main loop — envoy): spawn_agent
  //   Phase B (sub-loop — storyteller): 12 tool calls + done
  //   Phase C (main loop — envoy): final response
  const mockResponses = [
    // Phase A: Envoy spawns storyteller (matches prompt example pattern)
    `I'll delegate this to the storyteller.\n` + makeToolCall("spawn_agent", { agent: "storyteller", task: jobTask, workspace: storyPath }),

    // Phase B: Storyteller creates the story (matches storyteller prompt examples)
    `Let me check what exists first.\n` + makeToolCall("ls", { path: W("workspace") }),
    `The workspace is empty. I'll set up the story directory.\n` + makeToolCall("mkdir", { path: W("workspace/dragons") }),
    `Now I'll write the story plan.\n` + makeToolCall("write", { path: W("workspace/dragons/_plan.md"), content: PLAN_CONTENT }),
    `Writing chapter 1.\n` + makeToolCall("write", { path: W("workspace/dragons/chapter-001.md"), content: CH1_CONTENT }),
    `Writing chapter 2.\n` + makeToolCall("write", { path: W("workspace/dragons/chapter-002.md"), content: CH2_CONTENT }),
    `Writing chapter 3.\n` + makeToolCall("write", { path: W("workspace/dragons/chapter-003.md"), content: CH3_CONTENT }),
    `Creating wiki directories.\n` + makeToolCall("mkdir", { path: W("workspace/dragons/wiki/character") }),
    makeToolCall("write", { path: W("workspace/dragons/wiki/character/eryndor.md"), content: WIKI_ERYNDOR }),
    makeToolCall("mkdir", { path: W("workspace/dragons/wiki/location") }),
    makeToolCall("write", { path: W("workspace/dragons/wiki/location/dragon-peak.md"), content: WIKI_DRAGON_PEAK }),
    makeToolCall("mkdir", { path: W("workspace/dragons/wiki/faction") }),
    makeToolCall("write", { path: W("workspace/dragons/wiki/faction/emerald-claw.md"), content: WIKI_EMERALD_CLAW }),
    // Storyteller finishes (no tool calls → sub-loop exits)
    `Done! All chapters and wiki entries created.`,

    // Phase C: Envoy responds to user (no tool calls → main loop exits)
    `Created the dragon story. Files are in ${storyPath}.`,
  ]

  const trace = new TraceWriter("oracle").open()
  trace.infoAbout("run", { mode: "oracle", baseDir })
  const engine = new MockModel(mockResponses)
  const userInput = "Create a story about dragons with 3 first chapters and an up-to-date wiki."
  const storytellerHandlersWithMkdir: Record<string, ToolHandler> = {
    ...storytellerHandlers,
    mkdir: (args) => mkdirTool({ path: args.path as string }),
  }

  const envoyPrompt = buildEnvoyPrompt()
  trace.inputBlock(envoyPrompt + "\n\nUser: " + userInput + "\n\nAssistant:")
  let subToolCalls = 0


  const mainResult = await runAgentLoop(
    engine,
    envoyPrompt,
    {
      spawn_agent: async (args) => {
        const task = args.task as string
        trace.infoSection("spawn_agent: storyteller")
        trace.infoAbout("task", { description: task })
        console.error(`  ENVOY spawned "${args.agent}" with task: ${task.slice(0, 60)}...`)

        // Run storyteller sub-loop (consumes next mock responses)
        const storytellerPrompt = buildStorytellerPrompt(storytellerToolDefs)
        const subResult = await runAgentLoop(
          engine,
          storytellerPrompt,
          storytellerHandlersWithMkdir,
          task,
          15,
          { onToolCall: (name, success) => {
            subToolCalls++
            console.error(`  STORYTELLER depth: tool "${name}" → success=${success}`)
          }, trace, tag: "storyteller" },
        )

        return {
          summary: subResult.finalText.slice(0, 500),
          filesCreated: [
            `${storyPath}/_plan.md`,
            `${storyPath}/chapter-001.md`,
            `${storyPath}/chapter-002.md`,
            `${storyPath}/chapter-003.md`,
            `${storyPath}/wiki/character/eryndor.md`,
            `${storyPath}/wiki/location/dragon-peak.md`,
            `${storyPath}/wiki/faction/emerald-claw.md`,
          ],
        }
      },
    },
    userInput,
    10,
    { trace, tag: "envoy", genOpts: { grammar: toolsToGbnfWithThink(envoyToolDefs) } },
  )

  console.error(`\nEnvoy tool calls: 1 (spawn_agent)`)
  console.error(`Storyteller tool calls: ${subToolCalls}`)

  // ── Verification ──
  interface Check { name: string; pass: boolean }
  const checks: Check[] = [
    { name: "workspace dir", pass: fs.existsSync(W("workspace")) && fs.statSync(W("workspace")).isDirectory() },
    { name: "story dir", pass: fs.existsSync(W("workspace/dragons")) && fs.statSync(W("workspace/dragons")).isDirectory() },
    { name: "plan file", pass: fs.existsSync(W("workspace/dragons/_plan.md")) },
    { name: "chapter 1", pass: fs.existsSync(W("workspace/dragons/chapter-001.md")) },
    { name: "chapter 2", pass: fs.existsSync(W("workspace/dragons/chapter-002.md")) },
    { name: "chapter 3", pass: fs.existsSync(W("workspace/dragons/chapter-003.md")) },
    { name: "wiki character dir", pass: fs.existsSync(W("workspace/dragons/wiki/character")) },
    { name: "character entry", pass: fs.existsSync(W("workspace/dragons/wiki/character/eryndor.md")) },
    { name: "wiki location dir", pass: fs.existsSync(W("workspace/dragons/wiki/location")) },
    { name: "location entry", pass: fs.existsSync(W("workspace/dragons/wiki/location/dragon-peak.md")) },
    { name: "wiki faction dir", pass: fs.existsSync(W("workspace/dragons/wiki/faction")) },
    { name: "faction entry", pass: fs.existsSync(W("workspace/dragons/wiki/faction/emerald-claw.md")) },
    { name: "plan content correct", pass: fs.readFileSync(W("workspace/dragons/_plan.md"), "utf-8") === PLAN_CONTENT },
    { name: "ch1 content correct", pass: fs.readFileSync(W("workspace/dragons/chapter-001.md"), "utf-8") === CH1_CONTENT },
    { name: "ch2 content correct", pass: fs.readFileSync(W("workspace/dragons/chapter-002.md"), "utf-8") === CH2_CONTENT },
    { name: "ch3 content correct", pass: fs.readFileSync(W("workspace/dragons/chapter-003.md"), "utf-8") === CH3_CONTENT },
    { name: "wiki eryndor correct", pass: fs.readFileSync(W("workspace/dragons/wiki/character/eryndor.md"), "utf-8") === WIKI_ERYNDOR },
    { name: "wiki dragon-peak correct", pass: fs.readFileSync(W("workspace/dragons/wiki/location/dragon-peak.md"), "utf-8") === WIKI_DRAGON_PEAK },
    { name: "wiki emerald-claw correct", pass: fs.readFileSync(W("workspace/dragons/wiki/faction/emerald-claw.md"), "utf-8") === WIKI_EMERALD_CLAW },
    { name: "envoy returned text", pass: mainResult.finalText.length > 0 },
    { name: "storyteller made all 12 tool calls", pass: subToolCalls === 12 },
    { name: "all mock responses consumed", pass: engine.callCount === mockResponses.length },
  ]

  let passCount = 0
  console.error("\n── Oracle Verification ──")
  for (const check of checks) {
    const status = check.pass ? "PASS" : "FAIL"
    console.error(`  [${status}] ${check.name}`)
    if (check.pass) passCount++
  }

  const allPass = passCount === checks.length
  console.error(`\n${passCount}/${checks.length} ${allPass ? "PASS" : "FAIL"}`)

  trace.verification(checks)
  trace.close()
  console.error(`\nTrace: ${trace.path}`)
  return allPass
}

// ──────────────────────────────────────────────
// Live mode
// ──────────────────────────────────────────────

async function runLive(baseDir: string, W: (p: string) => string, args: string[]): Promise<boolean> {
  console.error("── Live mode (envoy → storyteller) ──")

  const modelPath = args.find((a) => a.startsWith("--model="))?.split("=")[1]
    || path.join(PROJECT_ROOT, "models/rwkv7-g1g-2.9b-20260526-ctx8192-Q4_K_M.gguf")
  const gpu = (args.find((a) => a.startsWith("--gpu="))?.split("=")[1] || "vulkan") as "vulkan" | "cuda" | "auto"

  console.error(`Model: ${path.basename(modelPath)}`)
  console.error(`GPU: ${gpu}`)
  console.error(`Workspace: ${baseDir}`)

  const { model, close } = await bootRemoteModel({ modelPath, gpu })
  const engineClient = model as HttpModel

  const envoyGrammar = toolsToGbnfWithThink(envoyToolDefs)
  const storytellerGrammar = toolsToGbnfWithThink(storytellerToolDefs)

  const envoyPrompt = buildEnvoyPrompt()
  const userInput = "Create a story about dragons with 3 first chapters and an up-to-date wiki."

  let finalText = ""
  let subToolCalls = 0

  const { AgentLoop } = await import("../agent/loop.ts")
  const { SessionManager } = await import("../session/session.ts")
  const storytellerPrompt = buildStorytellerPrompt(storytellerToolDefs)

  const trace = new TraceWriter("live").open()
  const infoData: Record<string, string> = {
    model: path.basename(modelPath),
    gpu,
    workspace: baseDir,
  }
  if (engineClient.loraAdapters.length) {
    infoData.lora = engineClient.loraAdapters.map(a => a.filePath).join(", ")
  }
  infoData.mose = "none"
  trace.infoAbout("run", infoData)
  trace.inputBlock(envoyPrompt + "\n\nUser: " + userInput + "\n\nAssistant:")

  const result = await runAgentLoop(
    model as Model,
    envoyPrompt,
    {
      spawn_agent: async (args) => {
        const task = args.task as string
        trace.infoSection("spawn_agent: storyteller")
        trace.infoAbout("task", { description: task })
        trace.infoSection("storyteller system")
        trace.outputStream(storytellerPrompt)
        console.error(`\nENVOY spawned "${args.agent}"`)
        const subSession = new SessionManager(baseDir, "storyteller-dragons", modelPath)
        await subSession.ensureDir()

        const subLoop = new AgentLoop(model as Model, subSession, 15, {
          systemPrompt: storytellerPrompt,
          toolDefs: storytellerToolDefs,
          toolHandlers: {
            ...storytellerHandlers,
            mkdir: (margs: Record<string, unknown>) => mkdirTool({ path: margs.path as string }),
          },
        })

        trace?.infoSection("storyteller sub-loop")
        trace?.infoAbout("input", { chars: String(task.length) })
        const subResult = await subLoop.run(task, {
          onText: (t: string) => {
            process.stdout.write(t)
            trace?.outputStream(t)
          },
        })

        return {
          summary: subResult.slice(0, 500),
          sessionId: subSession.sessionIdStr,
        }
      },
    },
    userInput,
    10,
    {
      onToolCall: (name, success) => {
        if (name !== "spawn_agent") {
          subToolCalls++
          console.error(`  depth: tool "${name}" → success=${success}`)
        }
      },
      trace,
      tag: "envoy",
      genOpts: { maxTokens: 500, grammar: envoyGrammar },
    },
  )

  finalText = result.finalText

  const storyDir = findStoryDir(baseDir)
  const storyName = storyDir ? path.basename(storyDir) : "(not found)"

  interface Check { name: string; pass: boolean }
  const checks: Check[] = [
    { name: `workspace dir exists`, pass: fs.existsSync(baseDir) },
    { name: `story dir found (${storyName})`, pass: storyDir !== null },
    { name: "plan file exists (_plan.md)", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "_plan.md")) },
    { name: "at least 1 chapter", pass: countChapterFiles(storyDir) >= 1 },
    { name: "at least 3 chapters", pass: countChapterFiles(storyDir) >= 3 },
    { name: "wiki character dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "character")) },
    { name: ">=1 character entry", pass: countFilesInDir(storyDir, "wiki", "character") >= 1 },
    { name: "wiki location dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "location")) },
    { name: ">=1 location entry", pass: countFilesInDir(storyDir, "wiki", "location") >= 1 },
    { name: "wiki faction dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "faction")) },
    { name: ">=1 faction entry", pass: countFilesInDir(storyDir, "wiki", "faction") >= 1 },
    { name: "envoy returned text", pass: finalText.length > 0 },
    { name: "at least 1 tool call", pass: subToolCalls > 0 },
  ]

  let passCount = 0
  console.error("\n── Live Verification ──")
  for (const check of checks) {
    const status = check.pass ? "PASS" : "FAIL"
    console.error(`  [${status}] ${check.name}`)
    if (check.pass) passCount++
  }

  if (storyDir) {
    console.error(`\nStory files:`)
    printTree(storyDir)
  }

  const allPass = passCount === checks.length
  console.error(`\n${passCount}/${checks.length} ${allPass ? "PASS" : "FAIL"}`)

  trace.verification(checks)
  trace.close()
  console.error(`\nTrace: ${trace.path}`)

  await close()
  return allPass
}

function findStoryDir(baseDir: string): string | null {
  try {
    for (const entry of fs.readdirSync(baseDir)) {
      const full = path.join(baseDir, entry)
      if (fs.statSync(full).isDirectory()) return full
    }
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const isLive = args.includes("--live")

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-story-"))
  console.error(`Base dir: ${tmpDir}`)
  const W = (p: string) => path.join(tmpDir, p)

  let success: boolean

  if (isLive) {
    try {
      success = await runLive(tmpDir, W, args)
    } catch (err) {
      console.error(`Live mode error: ${err instanceof Error ? err.message : String(err)}`)
      success = false
    }
    console.error(`\nFiles preserved: ${tmpDir}`)
  } else {
    success = await runOracle(tmpDir, W)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    console.error(`Cleaned up: ${tmpDir}`)
  }

  if (success) {
    console.log("EVAL PASSED")
    return 0
  } else {
    console.log("EVAL FAILED")
    return 1
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("Eval error:", err)
  process.exit(1)
})
