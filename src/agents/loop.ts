import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import type { Model } from "../types.ts"
import { SessionManager } from "../session/session.ts"
import { GenerateOpts, DEFAULT_GEN_OPTS, GenerateCallbacks, ToolCall, ToolResult, ToolDef, ToolHandler } from "../types.ts"
import { toolDefs as defaultToolDefs, toolHandlers as defaultHandlers, toolsToXml, toolsToGbnfWithThink } from "../tools/registry.ts"
import { renderDefaultExamples } from "./examples.ts"

/**
 * SEP — blank-line indicator inserted between turns in the prompt.
 * RWKV vocab includes \x00 so it tokenizes cleanly. Replaces empty lines
 * that would otherwise separate Assistant output from User tool responses.
 *
 * STOP_SEQ — generation stops when any of these strings appear.
 * Primary stop is </tool_call>. \n\n is the universal "next turn" indicator
 * (User: or Assistant:).
 *
 * To experiment: change SEP and/or add/remove items from STOP_SEQ.
 */
const SEP = "\n\n"
const STOP_SEQ = ["</tool_call>", "\n\nUser:", "\x03"]

function clean(txt: string): string {
  return txt.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = resolve(__dirname, "../agents")

const DEFAULT_SYSTEM_PREAMBLE = `You can use tools to read and write files. Output tool calls inside <tool_call> tags.`
const DEFAULT_EXAMPLES = renderDefaultExamples()

function fixToolCallJson(raw: string): string {
  try { JSON.parse(raw); return raw } catch {}

  let result = ""
  let inString = false
  let escaped = false

  const escapeMap: Record<string, string> = {
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
  }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === "\\" && inString) { result += ch; escaped = true; continue }
    if (escaped) { result += ch; escaped = false; continue }

    if (ch === '"') {
      if (!inString) {
        inString = true
        result += '"'
      } else {
        const rest = raw.slice(i + 1).trimStart()
        if (rest.length > 0 && ',:}]'.includes(rest[0])) {
          inString = false
          result += '"'
        } else {
          result += '\\"'
        }
      }
    } else if (inString && escapeMap[ch] !== undefined) {
      result += escapeMap[ch]
    } else {
      result += ch
    }
  }
  return result
}

export interface AgentLoopConfig {
  systemPrompt?: string
  toolDefs?: ToolDef[]
  toolHandlers?: Record<string, ToolHandler>
  examples?: string
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (result: ToolResult) => void
}

export function formatToolResult(result: ToolResult): string {
  const payload = result.success && !result.error
    ? { name: result.name, result: result.data ?? { success: true } }
    : { name: result.name, result: { success: false, error: result.error } }
  const body = JSON.stringify(payload)
  const truncated = body.length > 2000 ? body.slice(0, 2000) + "..." : body
  return `<tool_response>\n${truncated}\n</tool_response>`
}

export class AgentLoop {
  private model: Model
  private session: SessionManager
  private maxDepth: number
  private config: Required<AgentLoopConfig>
  private sessionId: string
  private initPromise: Promise<void>
  private lastCallSignatures: string[] = []

  constructor(model: Model, session: SessionManager, maxDepth = 5, config?: AgentLoopConfig) {
    this.model = model
    this.session = session
    this.maxDepth = maxDepth
    this.config = {
      systemPrompt: config?.systemPrompt ?? DEFAULT_SYSTEM_PREAMBLE,
      toolDefs: config?.toolDefs ?? defaultToolDefs,
      toolHandlers: config?.toolHandlers ?? defaultHandlers,
      examples: config?.examples ?? DEFAULT_EXAMPLES,
      onToolCall: config?.onToolCall ?? (() => {}),
      onToolResult: config?.onToolResult ?? (() => {}),
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
    const sess = this.session.get()
    sess.status = "active"

    await this.initPromise

    const history = this.session.buildPrompt(this.buildSystemPrompt(), true)
    const thinkSuffix = userInput.includes("(think") ? "" : " (think a little)"
    let fullPrompt = clean(history + "User: " + userInput + thinkSuffix + "\n\nAssistant:")
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
          stopSequences: STOP_SEQ,
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

      const { text, toolCalls, errors } = this.parseToolCalls(raw)
      callbacks?.onText?.(text)
      finalText += text

      const allCalls = [...toolCalls, ...errors]
      if (allCalls.length === 0) {
        if (endedWithUser || raw.includes(SEP)) break
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
          resultsBlock += `<tool_response>\n{"name":"${call.name}","result":{"success":false,"error":"${msg}"}}\n</tool_response>\n`
          continue
        }

        const result = await this.execTool(call)
        this.config.onToolResult?.(result)
        resultsBlock += this.formatToolResult(result) + "\n"
      }
      fullPrompt += rawForPrompt + SEP + "User:\n" + resultsBlock.trim() + "\n\nAssistant:"
      await this.session.save()
      depth++
    }

    callbacks?.onDone?.()

    this.session.addMessage({ role: "user", content: userInput })
    this.session.addMessage({ role: "assistant", content: finalText })
    await this.session.save()

    return this.cleanOutput(finalText)
  }

  private buildSystemPrompt(): string {
    const tools = this.config.toolDefs.map(t => {
      const params = t.parameters.map(p =>
        `${p.name}${p.required ? "" : "?"}: ${p.type}`
      ).join(", ")
      return `- ${t.name}(${params}) — ${t.description}`
    }).join("\n")
    return clean("System: " + this.config.systemPrompt + "\n\nTools:\n" + tools)
  }

  parseToolCalls(text: string): {
    text: string
    toolCalls: ToolCall[]
    beforeFirst: string
    errors: ToolCall[]
  } {
    const toolCalls: ToolCall[] = []
    const errors: ToolCall[] = []
    const segments: string[] = []
    let lastIndex = 0

    const toolCallTag = /<tool_call>/g
    let tagMatch: RegExpExecArray | null
    while ((tagMatch = toolCallTag.exec(text)) !== null) {
      const openPos = tagMatch.index
      segments.push(text.slice(lastIndex, openPos))
      const searchStart = tagMatch.index + tagMatch[0].length

      const closeTag = text.indexOf("</tool_call>", searchStart)
      if (closeTag === -1) {
        lastIndex = openPos
        break
      }

      const body = text.slice(searchStart, closeTag)
      const braceStart = body.indexOf("{")
      if (braceStart === -1) {
        errors.push({ name: "__parse_error__", args: { raw: text.slice(openPos, closeTag + 12) } })
        lastIndex = closeTag + 12
        continue
      }

      let depth = 0
      let inStr = false
      let escaped = false
      let matchEnd = -1
      for (let i = braceStart; i < body.length; i++) {
        const ch = body[i]
        if (escaped) { escaped = false; continue }
        if (ch === "\\" && inStr) { escaped = true; continue }
        if (ch === '"') { inStr = !inStr; continue }
        if (!inStr) {
          if (ch === "{") depth++
          else if (ch === "}") {
            depth--
            if (depth === 0) { matchEnd = i + 1; break }
          }
        }
      }

      if (matchEnd === -1) {
        errors.push({ name: "__parse_error__", args: { raw: text.slice(openPos, closeTag + 12) } })
        lastIndex = closeTag + 12
        continue
      }

      const jsonRaw = body.slice(braceStart, matchEnd)
      lastIndex = closeTag + 12
      try {
        const json = fixToolCallJson(jsonRaw)
        const parsed = JSON.parse(json)
        if (!parsed.name || typeof parsed.name !== "string") throw new Error("missing name")
        const args = parsed.arguments ?? parsed.args
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("missing arguments object")
        const call: ToolCall = { name: parsed.name, args }
        toolCalls.push(call)
      } catch (e) {
        errors.push({ name: "__parse_error__", args: { raw: text.slice(openPos, lastIndex) } })
      }
    }
    segments.push(text.slice(lastIndex))

    const beforeFirst = segments[0] ?? ""
    const cleaned = segments.join("").trim()

    return { text: cleaned, toolCalls, beforeFirst, errors }
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

  formatToolResult(result: ToolResult): string {
    return formatToolResult(result)
  }

  cleanOutput(text: string): string {
    return text
      .replace(/^Assistant:\s*/i, "")
      .replace(/\x03/g, "")
      .trim()
  }

  async dispose() {
    await this.session.save()
  }
}
