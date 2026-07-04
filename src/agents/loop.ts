import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import type { Engine } from "../types.ts"
import { Session } from "../session/session.ts"
import { MessagePart } from "../protocol/message-part.ts"
import { GenerateOpts, DEFAULT_GEN_OPTS, GenerateCallbacks, ToolCall, ToolResult, ToolDef, ToolHandler } from "../types.ts"
import { toolDefs as defaultToolDefs, toolHandlers as defaultHandlers, toolsToXml, toolsToGbnfWithThink } from "../tools/registry.ts"
import { getTemplate, renderDefaultExamples } from "./examples.ts"
import {
  getFormatConfig,
  renderToolResponseBlock,
  formatToolResponseRole,
  formatAssistantRole,
} from "./format-config.ts"
import { clean, fixToolCallJson } from "../model/adapter-utils.ts"
import { parseToolCalls as adapterParseToolCalls } from "../model/adapter.ts"
import { StateTuneCache, getDefaultStateTuneCache } from "../core/state-tune-cache.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = resolve(__dirname, "../agents")

const DEFAULT_SYSTEM_PREAMBLE = `You can use tools to read and write files. Output tool calls inside <tool_call> tags.`
const DEFAULT_EXAMPLES = renderDefaultExamples()

export interface AgentLoopConfig {
  systemPrompt?: string
  toolDefs?: ToolDef[]
  toolHandlers?: Record<string, ToolHandler>
  examples?: string
  templateName?: string
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (result: ToolResult) => void
  /** Called to persist session state after each turn (Phase 5 bridge). */
  saveSession?: () => Promise<void>
  /**
   * Skip re-baking state-tune examples through the model when the
   * content hash matches a prior run. Defaults to true (use the
   * process-wide cache). Pass `false` to force re-processing.
   */
  useStateTuneCache?: boolean
}

export class AgentLoop {
  private model: Engine
  private session: Session
  private maxDepth: number
  private config: Required<AgentLoopConfig>
  sessionId: string
  private initPromise: Promise<void>
  private lastCallSignatures: string[] = []
  private template: ReturnType<typeof getTemplate>

  constructor(model: Engine, session: Session, maxDepth = 5, config?: AgentLoopConfig) {
    this.model = model
    this.session = session
    this.maxDepth = maxDepth
    this.template = getTemplate(config?.templateName ?? "default")
    const useCache = config?.useStateTuneCache ?? true
    this.config = {
      systemPrompt: config?.systemPrompt ?? DEFAULT_SYSTEM_PREAMBLE,
      toolDefs: config?.toolDefs ?? defaultToolDefs,
      toolHandlers: config?.toolHandlers ?? defaultHandlers,
      examples: config?.examples ?? DEFAULT_EXAMPLES,
      templateName: config?.templateName ?? "default",
      onToolCall: config?.onToolCall ?? (() => {}),
      onToolResult: config?.onToolResult ?? (() => {}),
      saveSession: config?.saveSession ?? (() => Promise.resolve()),
      useStateTuneCache: useCache,
    }
    const cache: StateTuneCache | null = useCache ? getDefaultStateTuneCache() : null
    if (typeof (model as Partial<Engine> & { setStateTuneCache?: unknown }).setStateTuneCache === "function") {
      (model as unknown as { setStateTuneCache(c: StateTuneCache | null): void }).setStateTuneCache(cache)
    }
    this.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.initPromise = model.process({
      systemPrompt: this.config.systemPrompt,
      append: this.config.examples ? { role: "system", content: this.config.examples } : undefined,
    }).then(({ sessionId }) => {
      this.sessionId = sessionId
    })
  }

  async run(
    userInput: string,
    callbacks?: GenerateCallbacks,
    opts: Partial<GenerateOpts> = {},
  ): Promise<string> {
    await this.initPromise

    const cfg = getFormatConfig()
    const history = this.session.buildPrompt(this.buildSystemPrompt(), true)
    const thinkSuffix = userInput.includes("(think") ? "" : " (think a little)"
    let fullPrompt = clean(
      history +
        this.template.formatUserInput(userInput + thinkSuffix) +
        cfg.sep +
        this.template.formatAssistantRole()
    )
    let finalText = ""
    let depth = 0

    while (depth < this.maxDepth) {
      callbacks?.onPrompt?.(fullPrompt)
      let rawRaw = ""
      const genRes = await this.model.streamGenerate({
        sessionId: this.sessionId,
        prompt: fullPrompt,
        opts: {
          ...DEFAULT_GEN_OPTS,
          temperature: 0.7,
          stopSequences: [...cfg.stops.list],
          grammar: toolsToGbnfWithThink(this.config.toolDefs),
          ...opts,
        },
        onToken: (token: string) => {
          rawRaw += token
          callbacks?.onToken?.(token)
        },
      })
      if (genRes.text.length > rawRaw.length) rawRaw = genRes.text

      const raw = rawRaw.replace(/\x03/g, "")
      const endedWithToolCall = raw.endsWith("</tool_call>")
      const endedWithUser = !endedWithToolCall && (raw.includes("\n\nUser:") || raw.endsWith("\x03"))
      callbacks?.onRawOutput?.(raw)

      // Runtime output format check — surface bad patterns immediately
      const firstLine = raw.split("\n")[0]
      if (firstLine && !firstLine.startsWith("\t") && firstLine.trim().length > 0) {
        console.warn(`[agent-loop] WARN: output lacks \\t prefix: ${JSON.stringify(firstLine.slice(0, 40))}`)
      }
      const badPatternMatch = raw.match(/^(\t[^\n]*)?\n\t(system:|User:|Assistant:)/mi)
      if (badPatternMatch) {
        console.warn(`[agent-loop] WARN: role/instruction echo detected: ${JSON.stringify(badPatternMatch[0].slice(0, 40))}`)
      }

      // Empty stream guard: the model emitted no parseable tokens. The grammar
      // and stop sequences should always admit at least one token of output,
      // so an empty `raw` is a model failure (likely stale state, corrupted
      // RNN context, or a stop sequence that fires before any token). Surface
      // the warning so the trace tells us what happened — and so the eval
      // never silently reports "assistant: <blank>" again.
      if (raw.trim().length === 0) {
        const msg = `[agent-loop] WARN: empty generation at depth ${depth} (stopReason=${genRes.stopReason})`
        callbacks?.onText?.(msg)
        console.warn(msg)
        break
      }

      const { text, toolCalls, errors } = adapterParseToolCalls(raw)
      callbacks?.onText?.(text)
      finalText += text

      const allCalls = [...toolCalls, ...errors]
      if (allCalls.length === 0) {
        if (endedWithUser || raw.includes(cfg.sep)) break
        break
      }

      // Strip everything after the last </tool_call> to prevent hallucinated
      // \n\nUser: or other stop sequences from corrupting the next prompt
      const lastClose = raw.lastIndexOf("</tool_call>")
      const rawForPrompt = lastClose !== -1 ? raw.slice(0, lastClose + 12) : raw

      let resultsBlock = ""
      for (const call of allCalls) {
        this.config.onToolCall?.(call.name, call.args)

        if (this.isRepeatedLoop(call, depth)) {
          const msg = "You called " + call.name + " with the same path " + depth + " times. Try a different approach — use write to create a .md file."
          const errorResult: ToolResult = { name: call.name, success: false, data: null, error: msg }
          resultsBlock += renderToolResponseBlock(errorResult) + "\n"
          continue
        }

        const result = await this.execTool(call)
        this.config.onToolResult?.(result)
        resultsBlock += renderToolResponseBlock(result) + "\n"
      }
      // Only send delta — state already has previous prompt + generated tokens baked in.
      // Re-sending old text double-counts in the RNN state and corrupts it.
      // The state already ends with `</tool_call>`. We append only the delta:
      //   "block"  — own User turn:  `\n\nUser:\n<tool_response>…</tool_response>\n\nAssistant:`
      //   "inline" — direct follow-up: `\n\t<tool_response>…</tool_response>` (same assistant turn, per EXAMPLE.md)
      if (cfg.toolResponse.placement === "inline") {
        fullPrompt = "\n" + resultsBlock.trim()
      } else {
        fullPrompt =
          cfg.sep + formatToolResponseRole() + resultsBlock.trim() + cfg.sep + formatAssistantRole()
      }
      await this.config.saveSession()
      depth++
    }

    callbacks?.onDone?.()

    this.session.input(MessagePart.user(userInput), MessagePart.text(finalText))
    await this.config.saveSession()

    return this.cleanOutput(finalText)
  }

  private buildSystemPrompt(): string {
    const tools = this.config.toolDefs.map(t => {
      const params = t.parameters.map(p =>
        `${p.name}${p.required ? "" : "?"}: ${p.type}`
      ).join(", ")
      return `- ${t.name}(${params}) — ${t.description}`
    }).join("\n\t\t")
    return clean("System:\n\t" + this.config.systemPrompt.replace(/\n/g, "\n\t") + "\n\t<tools>\n\t\t" + tools + "\n\t</tools>")
  }

  private isRepeatedLoop(call: ToolCall, depth: number): boolean {
    if (depth < 2) return false
    const pathKey = call.name === "write" ? call.name + ":" + (call.args.path as string) : call.name + ":" + JSON.stringify(call.args)
    this.lastCallSignatures.push(pathKey)
    if (this.lastCallSignatures.length > 8) this.lastCallSignatures.shift()
    let count = 0
    for (const s of this.lastCallSignatures) {
      if (s === pathKey) count++
    }
    return count >= 3
  }

  async execTool(call: ToolCall): Promise<ToolResult> {
    if (call.name === "__parse_error__") {
      return { name: "__parse_error__", success: false, data: null, error: "Parse error: tool call JSON was malformed. Use {\"name\": \"...\", \"args\": {...}} inside <tool_call> tags. Avoid real newlines in string values — use \\n instead." }
    }
    const handler = this.config.toolHandlers[call.name]
    if (!handler) {
      return { name: call.name, success: false, data: null, error: `Unknown tool: ${call.name}` }
    }
    try {
      const data = await handler(call.args)
      return { name: call.name, success: true, data, error: undefined }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { name: call.name, success: false, data: null, error: msg }
    }
  }

  cleanOutput(text: string): string {
    return text
      .replace(/^Assistant:\s*/i, "")
      .replace(/\x03/g, "")
      .trim()
  }

  async dispose() {
    await this.config.saveSession()
  }
}
