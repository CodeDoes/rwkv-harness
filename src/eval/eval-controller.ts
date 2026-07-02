import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { Model, ToolDef } from "../types.ts"
import type { LoadedAgent } from "../agents/agent-loader.ts"
import { AgentLoop } from "../agent/loop.ts"
import { SessionManager } from "../session/session.ts"
import { toolsToGbnfWithThink } from "../tools/registry.ts"
import mkdirTool from "../tools/mkdir.ts"
import { TraceWriter } from "./trace-writer.ts"
import { MockModel } from "./mock-engine.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "../..")

export interface RunResult {
  finalText: string
  subToolCalls: number
  storyDir: string | null
  storytellerOutput: string
}

export interface Check { name: string; pass: boolean }

export class EvalController {
  private baseDir: string
  private model: Model
  private sessionId: string
  private traceWriter: TraceWriter

  constructor(cfg: {
    baseDir: string
    model: Model
    sessionId: string
    trace: TraceWriter
  }) {
    this.baseDir = cfg.baseDir
    this.model = cfg.model
    this.sessionId = cfg.sessionId
    this.traceWriter = cfg.trace
  }

  get trace(): TraceWriter { return this.traceWriter }

  async bakeAgent(agent: LoadedAgent): Promise<void> {
    if (!agent.examples) return
    await this.model.loadCheckpoint("_clean")
    await this.model.evaluate(agent.examples)
    await this.model.saveCheckpoint(`fewshot-${agent.name}`)
  }

  async runAgentHierarchy(cfg: {
    envoy: LoadedAgent
    storyteller: LoadedAgent
    userInput: string
    onSpawnResult?: (args: Record<string, unknown>, subResult: string, storySession: SessionManager) => Record<string, unknown>
  }): Promise<RunResult> {
    let subToolCalls = 0
    let storytellerOutput = ""
    const { envoy, storyteller, userInput, onSpawnResult } = cfg

    await this.model.saveCheckpoint("_clean")
    if (envoy.examples) await this.bakeAgent(envoy)
    if (envoy.examples) await this.model.loadCheckpoint("fewshot-envoy")

    this.traceWriter.inputBlock(envoy.instructions + "\n\nUser: " + userInput + "\n\nAssistant:")
    this.traceWriter.outputBlock()

    const session = new SessionManager(this.baseDir, this.sessionId, "envoy")
    await session.ensureDir()

    const agentLoop = new AgentLoop(this.model, session, 1, {
      systemPrompt: envoy.instructions,
      examples: "",
      toolDefs: envoy.toolDefs,
      toolHandlers: {
        ...envoy.toolHandlers,
        spawn_agent: async (args) => {
          const agentName = args.agent as string
          const workspacePath = `workspace/${agentName}-${Date.now().toString(36)}`
          await mkdirTool({ path: workspacePath })
          const task = `${userInput} Write files to ${workspacePath}`
          this.traceWriter.infoSection("spawn_agent: storyteller")
          this.traceWriter.infoAbout("task", { description: task })
          this.traceWriter.infoAbout("workspace", { path: workspacePath })
          console.error(`\nENVOY spawned "${agentName}"`)

          await this.model.saveCheckpoint("envoy-pause")
          if (storyteller.examples) await this.bakeAgent(storyteller)
          if (storyteller.examples) await this.model.loadCheckpoint("fewshot-storyteller")

          const storySession = new SessionManager(
            session.sessionDirPath,
            workspacePath,
            "storyteller",
          )
          await storySession.ensureDir()

          const subLoop = new AgentLoop(this.model, storySession, 15, {
            systemPrompt: storyteller.instructions,
            examples: "",
            toolDefs: storyteller.toolDefs,
            toolHandlers: storyteller.toolHandlers,
            onToolCall: (name, toolArgs) => {
              subToolCalls++
              const pathStr = toolArgs.path ? ` ${toolArgs.path}` : ""
              const contentPreview = toolArgs.content ? ` (${String(toolArgs.content).slice(0, 60).replace(/\n/g, "\\n")}...)` : ""
              console.error(`  STORYTELLER depth: ${name}${pathStr}${contentPreview}`)
            },
            onToolResult: (result) => this.traceWriter.toolResultBlock(result),
          })

          this.traceWriter.infoSection("storyteller sub-loop")
          let subFirst = true
          const subResult = await subLoop.run(task, {
            onRawOutput: (raw) => {
              if (!subFirst) this.traceWriter.outputBlock()
              subFirst = false
              this.traceWriter.outputStream(raw)
            },
            onText: (t: string) => {
              process.stdout.write(t)
              storytellerOutput += t
            },
          }, { temperature: 0.5 })

          this.traceWriter.infoSection("summarization")
          const summaryPrompt = `\n\nUser: List the files you created.\n\nAssistant: I created files at`
          const summaryRaw = await this.model.generate(summaryPrompt, {
            temperature: 0.3,
            maxTokens: 100,
            stopSequences: ["\n\n", "\x03"],
          })
          const report = summaryRaw.replace(/\x03/g, "").trim()
          this.traceWriter.outputBlock()
          this.traceWriter.outputStream(report)

          await this.model.loadCheckpoint("envoy-pause")

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
    const finalText = await agentLoop.run(userInput, {
      onRawOutput: (raw) => {
        if (!firstOutput) this.traceWriter.outputBlock()
        firstOutput = false
        this.traceWriter.outputStream(raw)
      },
      onText: (t: string) => process.stdout.write(t),
    }, { maxTokens: 300 })

    const storyDir = this.findStoryDir(this.baseDir)
    return {
      finalText,
      subToolCalls,
      storyDir: storyDir ? path.basename(storyDir) : null,
      storytellerOutput,
    }
  }

  findStoryDir(baseDir: string): string | null {
    const workspace = path.join(baseDir, "workspace")
    try {
      for (const entry of fs.readdirSync(workspace)) {
        const full = path.join(workspace, entry)
        if (fs.statSync(full).isDirectory()) return entry
      }
    } catch { }
    return null
  }

  countChapterFiles(storyDir: string | null): number {
    if (!storyDir) return 0
    try {
      return fs.readdirSync(storyDir).filter((f) => /^chapter/i.test(f)).length
    } catch { return 0 }
  }

  countFilesInDir(storyDir: string | null, ...subdirs: string[]): number {
    if (!storyDir) return 0
    try {
      return fs.readdirSync(path.join(storyDir, ...subdirs)).filter((f) => f.endsWith(".md")).length
    } catch { return 0 }
  }

  printTree(dir: string, prefix = "") {
    try {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry)
        const isDir = fs.statSync(full).isDirectory()
        console.error(`  ${prefix}${entry}${isDir ? "/" : ""}`)
        if (isDir) this.printTree(full, prefix + "  ")
      }
    } catch { }
  }

  static async validateToolGrammar(defs: ToolDef[]): Promise<string | null> {
    try {
      const grammarStr = toolsToGbnfWithThink(defs)
      if (!grammarStr || grammarStr.length === 0) return "empty grammar"
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  static validateToolCallFormat(text: string, toolDefs: ToolDef[]): string[] {
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
      const args = parsed.arguments ?? parsed.args
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        errors.push(`tool_call "${parsed.name}" missing "arguments"/"args" object`)
      }
    }
    return errors
  }

  static reportVerification(label: string, checks: Check[], trace: TraceWriter): boolean {
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

  static createMockModel(responses: string[]): MockModel {
    return new MockModel(responses)
  }

  static resolveModelPath(args: string[]): string {
    return args.find((a) => a.startsWith("--model="))?.split("=")[1]
      || path.join(PROJECT_ROOT, "models/rwkv7-g1g-2.9b-20260526-ctx8192-converted.st")
  }

  static resolveGpu(args: string[]): "vulkan" | "cuda" | "auto" {
    return (args.find((a) => a.startsWith("--gpu="))?.split("=")[1] || "vulkan") as "vulkan" | "cuda" | "auto"
  }
}
