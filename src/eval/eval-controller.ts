import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { Engine, ToolDef } from "../types.ts"
import type { LoadedAgent } from "../agents/agent-loader.ts"
import { AgentLoop } from "../agents/loop.ts"
import { Session } from "../session/session.ts"
import { SessionManager } from "../session/session-manager.ts"
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
  private model: Engine
  private sessionId: string
  private traceWriter: TraceWriter

  constructor(cfg: {
    baseDir: string
    model: Engine
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

    const session = new Session({ id: this.sessionId, agentName: "envoy" })
    const manager = new SessionManager(this.baseDir, this.sessionId, "envoy")
    await manager.ensureDir()

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

          const storySession = new Session({ id: workspacePath, agentName: "storyteller" })
          const storyMgr = new SessionManager(
            manager.sessionDirPath,
            workspacePath,
            "storyteller",
          )
          await storyMgr.ensureDir()

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
            saveSession: () => storyMgr.saveFromSession(storySession),
          })

          // Wrap sub-agent blocks in <subagent> so the trace shows delegation boundaries.
          this.traceWriter.raw(`<subagent name="${agentName}" task="${taskText}">`)
          this.traceWriter.write("system", storyteller.instructions)
          this.traceWriter.write("user", taskText)

          let lastAssistantText = ""
          let subagentFirstToken = true
          const subResult = await subLoop.run(taskText, {
            onRawOutput: (_raw) => {
              if (!subagentFirstToken) {
                this.traceWriter.endLine()
                this.traceWriter.separator()
                subagentFirstToken = true
              }
            },
            onText: (t: string) => {
              storytellerOutput += t
              lastAssistantText = t
            },
            onToken: (t: string) => {
              if (subagentFirstToken) {
                this.traceWriter.beginLine("assistant:")
                subagentFirstToken = false
              }
              this.traceWriter.append(t)
              process.stdout.write(t)
            },
          }, { temperature: 0.5, maxTokens: 2048 })
          await this.model.interrupt(subLoop.sessionId).catch(() => {})
          if (!lastAssistantText) lastAssistantText = subResult
          this.traceWriter.raw(`</subagent>`)

          await this.model.loadCheckpoint("envoy-pause")

          const extra = onSpawnResult ? onSpawnResult(args, subResult, storyMgr) : {}
          return { summary: lastAssistantText, sessionId: storySession.id, ...extra }
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
      saveSession: () => manager.saveFromSession(session),
    })

    this.traceWriter.write("user", userInput)
    let envoyFirstToken = true
    let envoyRawCaptured = false
    const finalText = await agentLoop.run(userInput, {
      onRawOutput: (raw) => {
        if (!envoyFirstToken) {
          this.traceWriter.endLine()
          this.traceWriter.separator()
          envoyFirstToken = true
        }
        if (!envoyRawCaptured) {
          envoyRawCaptured = true
        }
      },
      onText: (t: string) => process.stdout.write(t),
      onToken: (t: string) => {
        if (envoyFirstToken) {
          this.traceWriter.beginLine("assistant:")
          envoyFirstToken = false
        }
        this.traceWriter.append(t)
        process.stdout.write(t)
      },
    }, { maxTokens: 500, temperature: 0.5 })
    await this.model.interrupt(agentLoop.sessionId).catch(() => {})

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

  /**
   * Validate the RAW assistant output at the STRICT level. This is the
   * contract examples are expected to satisfy — every line tab-indented,
   * role markers banned, balance required, etc. Drift in any of these
   * means the rendered example prompt would no longer match what the
   * grammar expects.
   */
  static validateAssistantOutput(raw: string): string[] {
    return this._validateAssistantOutputImpl(raw, { strict: true })
  }

  /**
   * Lenient validator — the GRAMMAR-level contract. The grammar requires:
   *   - block-level indented newlines (`\n\t` inside think-block /
   *     tool_call body),
   *   - JSON inside `<tool_call>` parses as `{name, arguments}`,
   *   - no echoed role markers (`system:`, `User:`, `Assistant:`),
   *   - balanced XML tags.
   *
   * Strict-only requirements (every prose line `\t`-prefixed, etc.) are
   * NOT enforced here, because the grammar leaves room for free text.
   * This is the contract we use for live output validation.
   */
  static validateAssistantOutputLenient(raw: string): string[] {
    return this._validateAssistantOutputImpl(raw, { strict: false })
  }

  private static _validateAssistantOutputImpl(raw: string, opts: { strict: boolean }): string[] {
    const errors: string[] = []
    if (!raw || raw.trim().length === 0) return errors

    // First character: tab-indent.
    if (raw.length > 0 && !raw.startsWith("\t")) {
      errors.push(`output must start with \\t (tab), got: ${JSON.stringify(raw.slice(0, 20))}`)
    }

    // Role-marker echo guard (always on — both modes).
    const lines = raw.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed.startsWith("system:") || trimmed.startsWith("User:") || trimmed.startsWith("Assistant:")) {
        errors.push(`line ${i + 1} contains role/instruction echo: ${JSON.stringify(trimmed.slice(0, 30))}`)
      }
    }

    // Per-line \t indentation — STRICT only.
    if (opts.strict) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        if (!line.startsWith("\t")) {
          if (trimmed.startsWith("</") || trimmed === "\x00") continue
          const prevLine = i > 0 ? lines[i - 1] : ""
          if (prevLine.startsWith("\t") && prevLine.endsWith(" ")) continue
          errors.push(`line ${i + 1} missing leading \\t: ${JSON.stringify(trimmed.slice(0, 40))}`)
        }
      }
    }

    // Grammar leaniant: every tool_call body parses as JSON.
    const tcMatches = [...raw.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)]
    for (const m of tcMatches) {
      const body = m[1]
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed !== "object" || parsed === null) {
          errors.push(`<tool_call> JSON not an object: ${JSON.stringify(body).slice(0, 60)}`)
        } else if (typeof parsed.name !== "string") {
          errors.push(`<tool_call> missing "name" string: ${JSON.stringify(body).slice(0, 60)}`)
        }
      } catch {
        errors.push(`<tool_call> JSON did not parse: ${body.slice(0, 60)}`)
      }
    }

    // Balanced XML tags.
    const tagStack: string[] = []
    const tagRe = /<\/?([a-zA-Z_]+)>/g
    let tagMatch: RegExpExecArray | null
    while ((tagMatch = tagRe.exec(raw)) !== null) {
      const full = tagMatch[0]
      const tagName = tagMatch[1]
      if (full.startsWith("</")) {
        if (tagStack.length === 0 || tagStack[tagStack.length - 1] !== tagName) {
          errors.push(`mismatched closing tag </${tagName}> (expected ${tagStack.length > 0 ? `</${tagStack[tagStack.length - 1]}>` : "no tag"})`)
        } else {
          tagStack.pop()
        }
      } else {
        tagStack.push(tagName)
      }
    }
    if (tagStack.length > 0) {
      errors.push(`unclosed tags: ${tagStack.map(t => `<${t}>`).join(", ")}`)
    }

    return errors
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
