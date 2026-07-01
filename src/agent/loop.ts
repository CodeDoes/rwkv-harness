import type { Model } from "../types.ts"
import { SessionManager } from "../session/session.ts"
import { GenerateOpts, DEFAULT_GEN_OPTS, GenerateCallbacks, ToolCall, ToolResult, ToolDef, ToolHandler } from "../types.ts"
import { toolDefs as defaultToolDefs, toolHandlers as defaultHandlers, toolsToXml, toolsToGbnfWithThink } from "../tools/registry.ts"

const DEFAULT_SYSTEM_PREAMBLE = `You can use tools to read and write files. When you need to use a tool, output:

<tool_call>
{"name": "tool_name", "args": { ... }}
</tool_call>

Then I'll run the tool and give you the result.`

const DEFAULT_EXAMPLES = `\n\nExamples:\n\nUser: list files in /tmp\n\nAssistant: <tool_call>\n{\"name\": \"ls\", \"args\": {\"path\": \"/tmp\"}}\n</tool_call>\n\nUser: <tool_result>\n{\"name\":\"ls\",\"result\":{\"success\":true,\"data\":[\"file1.txt\",\"file2.txt\"]}}\n</tool_result>\n\nAssistant: Here are the files in /tmp: file1.txt, file2.txt.\n\nUser: read file.txt\n\nAssistant: <tool_call>\n{\"name\": \"read\", \"args\": {\"path\": \"file.txt\"}}\n</tool_call>\n\nUser: <tool_result>\n{\"name\":\"read\",\"result\":{\"success\":true,\"data\":\"file contents here\"}}\n</tool_result>\n\nAssistant: The file contains: file contents here.`

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

function fixToolCallJson(raw: string): string {
  try { JSON.parse(raw); return raw } catch {}

  let result = ""
  let inString = false
  let escaped = false

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
    ? { name: result.name, result: { success: true, data: result.data ?? null } }
    : { name: result.name, result: { success: false, error: result.error } }
  const body = JSON.stringify(payload)
  const truncated = body.length > 2000 ? body.slice(0, 2000) + "..." : body
  return `<tool_result>\n${truncated}\n</tool_result>`
}

export class AgentLoop {
  private model: Model
  private session: SessionManager
  private maxDepth: number
  private config: Required<AgentLoopConfig>

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
  }

  async run(
    userInput: string,
    callbacks?: GenerateCallbacks,
    opts: Partial<GenerateOpts> = {},
  ): Promise<string> {
    const sess = this.session.get()
    sess.status = "active"

    const history = this.session.buildPrompt(this.buildSystemPrompt(), true)
    let fullPrompt = history + "User: " + userInput + "\n\nAssistant:"
    let finalText = ""
    let depth = 0

    while (depth < this.maxDepth) {
      const rawRaw = await this.model.generate(fullPrompt, {
        ...DEFAULT_GEN_OPTS,
        temperature: 0.7,
        stopSequences: ["</tool_call>", "\x03"],
        grammar: toolsToGbnfWithThink(this.config.toolDefs),
        ...opts,
      })
      const raw = rawRaw.replace(/\x03/g, "")
      callbacks?.onRawOutput?.(raw)

      const { text, toolCalls, errors } = this.parseToolCalls(raw)
      callbacks?.onText?.(text)
      finalText += text

      const allCalls = [...toolCalls, ...errors]
      if (allCalls.length === 0) break

      let resultsBlock = ""
      for (const call of allCalls) {
        this.config.onToolCall?.(call.name, call.args)
        const result = await this.execTool(call)
        this.config.onToolResult?.(result)
        resultsBlock += this.formatToolResult(result) + "\n"
      }
      fullPrompt += raw + "\n\nUser: " + resultsBlock.trim() + "\n\nAssistant:"
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
    return this.config.examples + "\n\nSystem:\n" + this.config.systemPrompt + "\n\nTools:\n" + toolsToXml(this.config.toolDefs)
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
    let match: RegExpExecArray | null

    const re = new RegExp(TOOL_CALL_RE.source, "g")
    while ((match = re.exec(text)) !== null) {
      segments.push(text.slice(lastIndex, match.index))
      lastIndex = re.lastIndex
      try {
        const json = fixToolCallJson(match[1])
        const parsed = JSON.parse(json)
        if (!parsed.name || typeof parsed.name !== "string") throw new Error("missing name")
        if (!parsed.args || typeof parsed.args !== "object" || Array.isArray(parsed.args)) throw new Error("missing args object")
        toolCalls.push({ name: parsed.name, args: parsed.args })
      } catch {
        errors.push({ name: "__parse_error__", args: { raw: match[0] } })
      }
    }
    segments.push(text.slice(lastIndex))

    const beforeFirst = segments[0] ?? ""
    const cleaned = segments.join("").trim()

    return { text: cleaned, toolCalls, beforeFirst, errors }
  }

  async execTool(call: ToolCall): Promise<ToolResult> {
    if (call.name === "__parse_error__") {
      return { name: "__parse_error__", success: false, data: null, error: "Parse error: tool call JSON was malformed. Use {\"name\": \"...\", \"args\": {...}} inside <tool_call> tags. Avoid unescaped quotes in string values — use \\\" instead." }
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
