import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { Model, ToolDef } from "../types.ts"
import type { LoadedAgent } from "../agents/agent-loader.ts"
import { AgentLoop } from "../agents/loop.ts"
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
  toolResponseCount: number
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

  async runAgentHierarchy(cfg: {
    envoy: LoadedAgent
    storyteller: LoadedAgent
    userInput: string
    onSpawnResult?: (args: Record<string, unknown>, subResult: string, storySession: SessionManager) => Record<string, unknown>
  }): Promise<RunResult> {
    let subToolCalls = 0
    let storytellerOutput = ""
    let toolResponseCount = 0
    const { envoy, storyteller, userInput, onSpawnResult } = cfg

    const session = new SessionManager(this.baseDir, this.sessionId, "envoy")
    await session.ensureDir()

    this.traceWriter.write("system", envoy.instructions)

    const agentLoop = new AgentLoop(this.model, session, 1, {
      systemPrompt: envoy.instructions,
      examples: envoy.examples,
      toolDefs: envoy.toolDefs,
      toolHandlers: {
        ...envoy.toolHandlers,
        spawn_agent: async (args) => {
          const agentName = args.agent as string
          const workspacePath = (args.workspace as string) || `workspace/${agentName}-${Date.now().toString(36)}`
          await mkdirTool({ path: workspacePath })
          const taskText = (args.task as string) || `${userInput} Write files to ${workspacePath}`
          console.error(`\nENVOY spawned "${agentName}"`)

          await this.model.saveCheckpoint("envoy-pause")

          const storySession = new SessionManager(
            session.sessionDirPath,
            workspacePath,
            "storyteller",
          )
          await storySession.ensureDir()

          const subLoop = new AgentLoop(this.model, storySession, 15, {
            systemPrompt: storyteller.instructions,
            examples: storyteller.examples,
            toolDefs: storyteller.toolDefs,
            toolHandlers: storyteller.toolHandlers,
            onToolCall: (name, toolArgs) => {
              subToolCalls++
              const pathStr = toolArgs.path ? ` ${toolArgs.path}` : ""
              const contentPreview = toolArgs.content ? ` (${String(toolArgs.content).slice(0, 60).replace(/\n/g, "\\n")}...)` : ""
              console.error(`  STORYTELLER depth: ${name}${pathStr}${contentPreview}`)
            },
            onToolResult: (result) => {
              toolResponseCount++
              this.traceWriter.write("tool", JSON.stringify(result))
            },
          })

          this.traceWriter.write("system", storyteller.instructions)
          this.traceWriter.write("user", taskText)
          let stStreamStarted = false
          const subResult = await subLoop.run(taskText, {
            onRawOutput: (raw) => {
              if (!stStreamStarted) this.traceWriter.write("assistant", raw)
            },
            onText: (t: string) => {
              storytellerOutput += t
            },
            onToken: (t: string) => {
              process.stdout.write(t)
              if (!stStreamStarted) {
                this.traceWriter.append("assistant: ")
                stStreamStarted = true
              }
              this.traceWriter.append(t)
            },
          }, { temperature: 0.5, maxTokens: 2048 })
          if (stStreamStarted) this.traceWriter.endLine()

          const summaryPrompt = `\n\nUser: Briefly report what was accomplished in the workspace.\n\nAssistant:`
          this.traceWriter.write("user", summaryPrompt)
          const summaryProc = await this.model.process()
          const summaryRes = await this.model.generate({
            sessionId: summaryProc.sessionId,
            prompt: summaryPrompt,
            opts: {
              temperature: 0.3,
              maxTokens: 100,
              stopSequences: ["\n\n", "\x03"],
            },
          })
          const report = summaryRes.text.replace(/\x03/g, "").trim()
          this.traceWriter.write("assistant", report)

          await this.model.interrupt(summaryProc.sessionId)
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
      onToolResult: (result) => {
        toolResponseCount++
        this.traceWriter.write("tool", JSON.stringify(result))
      },
    })

    this.traceWriter.write("user", userInput)
    let envoyStreamStarted = false
    const finalText = await agentLoop.run(userInput, {
      onRawOutput: (raw) => {
        if (!envoyStreamStarted) this.traceWriter.write("assistant", raw)
      },
      onText: (t: string) => process.stdout.write(t),
      onToken: (t: string) => {
        process.stdout.write(t)
        if (!envoyStreamStarted) {
          this.traceWriter.append("assistant: ")
          envoyStreamStarted = true
        }
        this.traceWriter.append(t)
      },
    }, { maxTokens: 500, temperature: 0.5 })
    if (envoyStreamStarted) this.traceWriter.endLine()

    const storyDir = this.findStoryDir(this.baseDir)
    return {
      finalText,
      subToolCalls,
      storyDir: storyDir ? path.basename(storyDir) : null,
      storytellerOutput,
      toolResponseCount,
    }
  }

  findStoryDir(baseDir: string): string | null {
    const workspace = path.join(baseDir, "workspace")
    try {
      const dirs = fs.readdirSync(workspace).filter(e => fs.statSync(path.join(workspace, e)).isDirectory())
      if (dirs.length === 0) return null
      dirs.sort((a, b) => fs.statSync(path.join(workspace, b)).mtimeMs - fs.statSync(path.join(workspace, a)).mtimeMs)
      return dirs[0]
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

  static validateExampleFormat(rendered: string, toolDefs: ToolDef[]): string[] {
    const errors: string[] = []
    // Split into turns by User: or end-of-string
    const turnRe = /Assistant:\s*([\s\S]*?)(?=\n\nUser:|$)/g
    let turnMatch: RegExpExecArray | null
    while ((turnMatch = turnRe.exec(rendered)) !== null) {
      const turn = turnMatch[1].trim()
      if (!turn) continue
      // Track position in the assistant turn
      let pos = 0
      // Optional think-block
      const thinkRe = /^<think>([\s\S]*?)<\/think>/
      const thinkMatch = turn.match(thinkRe)
      if (thinkMatch) {
        pos = thinkMatch[0].length
      }
      // Optional whitespace after think
      const afterThink = turn.slice(pos).trimStart()
      pos = turn.length - afterThink.length + (turn.length - pos - afterThink.length)
      // text? (no < allowed) then optional tool_call then optional trailing text
      const textBeforeCall = afterThink.match(/^[^<]*/)
      if (textBeforeCall) pos = turn.length - afterThink.length + textBeforeCall[0].length
      // Optional tool_call
      const remaining = turn.slice(pos).trim()
      if (remaining) {
        const callRe = /^<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/
        const callMatch = remaining.match(callRe)
        if (callMatch) {
          // Validate the JSON
          try {
            const parsed = JSON.parse(callMatch[1])
            const validNames = new Set(toolDefs.map(t => t.name))
            if (typeof parsed.name !== "string" || !parsed.name) {
              errors.push(`tool_call missing "name" in example turn: ${callMatch[1].slice(0, 60)}`)
            } else if (!validNames.has(parsed.name as string)) {
              errors.push(`invalid tool name "${parsed.name}" in example, valid: ${[...validNames].join(", ")}`)
            }
            const args = parsed.arguments ?? parsed.args
            if (!args || typeof args !== "object" || Array.isArray(args)) {
              errors.push(`tool_call "${parsed.name}" missing "arguments"/"args" in example`)
            }
          } catch {
            errors.push(`unparseable JSON in tool_call in example: ${callMatch[1].slice(0, 60)}`)
          }
          // Check trailing text (must not contain <)
          const afterCall = remaining.slice(callMatch[0].length).trim()
          if (/<[^<]/.test(afterCall)) {
            errors.push(`trailing text after tool_call contains illegal "<" in example turn: ${afterCall.slice(0, 40)}`)
          }
        } else {
          errors.push(`unexpected content after text in assistant turn (expected tool_call): ${remaining.slice(0, 60)}`)
        }
      }
    }
    return errors
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
      || path.join(PROJECT_ROOT, "models/rwkv7-g1h_preview4673-2.9b-20260701-ctx8192.st")
  }

  static resolveGpu(args: string[]): "vulkan" | "cuda" | "auto" {
    return (args.find((a) => a.startsWith("--gpu="))?.split("=")[1] || "vulkan") as "vulkan" | "cuda" | "auto"
  }
}
