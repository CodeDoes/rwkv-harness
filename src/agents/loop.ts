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

/**
 * Grammar for continuation calls (mid-tool-call JSON, max_length hit).
 * Allows ANY character — schoolmarm GBNF cannot express `</tool_call>`
 * as a single-token alternative in a subword tokenizer, so [^<]* would
 * prevent closing truncated tool calls/think blocks entirely.  By
 * letting through all characters the model can complete whatever was
 * interrupted; stop sequences bound the generation length.
 */
const CONTINUATION_GRAMMAR = `root ::= .*`
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
  /** Paths that have been `read` in the lifetime of this loop.
   *  Used to enforce the little‑coder‑style “read‑before‑edit” rule. */
  private readonly readPaths = new Set<string>()
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
    model.setStateTuneCache?.(cache)
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
    let continuation = false
    let continuationAccum = ""
    let continuationBailout = 0
    let emptyRetryCount = 0
    let thinkBlockRetryCount = 0

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
          ...(continuation ? { grammar: CONTINUATION_GRAMMAR } : { grammar: toolsToGbnfWithThink(this.config.toolDefs) }),
          ...opts,
        },
        onToken: (token: string) => {
          rawRaw += token
          callbacks?.onToken?.(token)
        },
      })
      if (genRes.text.length > rawRaw.length) rawRaw = genRes.text

      const raw = rawRaw
      const endedWithToolCall = raw.endsWith("</tool_call>")
      const endedWithUser = !endedWithToolCall && raw.includes("\n\nUser:")
      // NOTE: onRawOutput is NOT called here. It's called on each
      // non-continuation exit path below so continuation tokens merge
      // into the same assistant block in the trace.

      // Runtime output format check — surface bad patterns immediately
      const firstLine = raw.split("\n")[0]
      if (firstLine && !firstLine.startsWith("\t") && firstLine.trim().length > 0) {
        console.warn(`[agent-loop] WARN: output lacks \\t prefix: ${JSON.stringify(firstLine.slice(0, 40))}`)
      }
      const badPatternMatch = raw.match(/^(\t[^\n]*)?\n\t(system:|User:|Assistant:)/mi)
      if (badPatternMatch) {
        console.warn(`[agent-loop] WARN: role/instruction echo detected: ${JSON.stringify(badPatternMatch[0].slice(0, 40))}`)
      }

      // Empty stream guard: retry up to 3 times. The model may be in
      // a transient state glitch. Retry with same prompt and grammar
      // (NOT continuation mode) to give it another chance.
      if (raw.trim().length === 0) {
        emptyRetryCount++
        if (emptyRetryCount > 3) {
          callbacks?.onRawOutput?.(raw)
          const msg = `[agent-loop] WARN: empty generation at depth ${depth} after ${emptyRetryCount} retries (stopReason=${genRes.stopReason})`
          callbacks?.onText?.(msg)
          console.warn(msg)
          break
        }
        console.warn(`[agent-loop] retrying empty generation (attempt ${emptyRetryCount}/${3}) at depth ${depth}`)
        continue
      }
      emptyRetryCount = 0

      // Accumulate across continuation iterations so the parser can
      // find tool calls that span multiple generations (truncated by
      // max_length and continued).
      if (continuation) {
        continuationAccum += raw
      } else {
        continuationAccum = raw
      }

      const { text, toolCalls, errors } = adapterParseToolCalls(continuationAccum)

      const allCalls = [...toolCalls, ...errors]
      if (allCalls.length === 0) {
        if (endedWithUser) {
          // Think block without tool call — retry instead of silently
          // accepting, since the model stopped while thinking.
          const hasThinkBlock = raw.includes("<think>") && raw.includes("</think>")
          if (hasThinkBlock && raw.trim().length > 0) {
            thinkBlockRetryCount++
            if (thinkBlockRetryCount > 3) {
              callbacks?.onRawOutput?.(raw)
              callbacks?.onText?.(text)
              finalText += text
              break
            }
            console.warn(`[agent-loop] think block without tool call (attempt ${thinkBlockRetryCount}/3) — retrying`)
            fullPrompt = ""
            continue
          }
          callbacks?.onRawOutput?.(raw)
          callbacks?.onText?.(text)
          finalText += text
          break
        }
        if (genRes.stopReason === "length" && raw.trim().length > 0) {
          continuationBailout++
          if (continuationBailout > 5) {
            callbacks?.onRawOutput?.(raw)
            callbacks?.onText?.(text)
            finalText += text
            break
          }
          fullPrompt = ""
          continuation = true
          continue
        }
        if (raw.includes(cfg.sep)) {
          callbacks?.onRawOutput?.(raw)
          callbacks?.onText?.(text)
          finalText += text
          break
        }
        // Think block without tool call — model thought but didn't follow
        // through. Retry with empty prompt (original grammar, NOT
        // continuation mode) so the model can emit a call from its
        // post-think RNN state.
        const hasThinkBlock = raw.includes("<think>") && raw.includes("</think>")
        if (hasThinkBlock && raw.trim().length > 0) {
          thinkBlockRetryCount++
          if (thinkBlockRetryCount > 3) {
            callbacks?.onRawOutput?.(raw)
            callbacks?.onText?.(text)
            finalText += text
            break
          }
          console.warn(`[agent-loop] think block without tool call (attempt ${thinkBlockRetryCount}/3) — retrying`)
          fullPrompt = ""
          continue
        }
        callbacks?.onRawOutput?.(raw)
        callbacks?.onText?.(text)
        finalText += text
        break
      }
      callbacks?.onRawOutput?.(raw)
      callbacks?.onText?.(text)
      finalText += text
      continuation = false
      continuationBailout = 0
      thinkBlockRetryCount = 0

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

        // ── little‑coder style guard: a file must be `read` before it can
        //    be written to or edited.  The agent is told exactly which file
        //    is missing, so it can issue a `read` first.  Remembers all reads
        //    done so far in this `run()` lifecycle.
        if ((call.name === "write" || call.name === "edit") &&
            typeof call.args.path === "string" &&
            !this.readPaths.has(call.args.path)) {
          const path = call.args.path
          const msg = `You must call \`read\` on \`${path}\` before you can ${call.name === "write" ? "write to" : "edit"} it.`
          const errorResult: ToolResult = { name: call.name, success: false, data: null, error: msg }
          this.config.onToolResult?.(errorResult)
          resultsBlock += renderToolResponseBlock(errorResult) + "\n"
          continue
        }

        const result = await this.execTool(call)
        if (call.name === "read" && typeof call.args.path === "string") {
          this.readPaths.add(call.args.path)
        }
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
      
      .trim()
  }

  async dispose() {
    await this.config.saveSession()
  }
}
