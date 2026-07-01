import type { Model } from "../types.ts"
import { SessionManager } from "../session/session.ts"
import { GenerateOpts, DEFAULT_GEN_OPTS, GenerateCallbacks, ToolCall, ToolResult, ToolDef, ToolHandler } from "../types.ts"
import { toolDefs as defaultToolDefs, toolHandlers as defaultHandlers, toolsToXml, toolsToGbnfWithThink } from "../tools/registry.ts"

const DEFAULT_SYSTEM_PREAMBLE = `You can use tools to read and write files. When you need to use a tool, output:

<tool_call>
{"name": "tool_name", "args": { ... }}
</tool_call>

Then I'll run the tool and give you the result.`

const DEFAULT_EXAMPLES = `\n\nExamples:\n\nUser: list files in /tmp\n\nAssistant: <tool_call>\n{\"name\": \"ls\", \"args\": {\"path\": \"/tmp\"}}\n</tool_call>\n\nUser: <tool_result name=\"ls\" success=\"true\">\n[\"file1.txt\", \"file2.txt\"]\n</tool_result>\n\nAssistant: Here are the files in /tmp: file1.txt, file2.txt.\n\nUser: read file.txt\n\nAssistant: <tool_call>\n{\"name\": \"read\", \"args\": {\"path\": \"file.txt\"}}\n</tool_call>\n\nUser: <tool_result name=\"read\" success=\"true\">\n\"file contents here\"\n</tool_result>\n\nAssistant: The file contains: file contents here.`

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g

export interface AgentLoopConfig {
  systemPrompt?: string
  toolDefs?: ToolDef[]
  toolHandlers?: Record<string, ToolHandler>
  examples?: string
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

      const { text, toolCalls } = this.parseToolCalls(raw)
      callbacks?.onText?.(text)
      finalText += text

      if (toolCalls.length === 0) break

      for (const call of toolCalls) {
        const result = await this.execTool(call)
        const resultBlock = this.formatToolResult(result)
        fullPrompt += raw + "\n\nUser: " + resultBlock + "\n\nAssistant:"
      }
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
    return this.config.systemPrompt + "\n\nTools:\n" + toolsToXml(this.config.toolDefs) + this.config.examples
  }

  parseToolCalls(text: string): {
    text: string
    toolCalls: ToolCall[]
    beforeFirst: string
  } {
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

    const beforeFirst = segments[0] ?? ""
    const cleaned = segments.join("").trim()

    return { text: cleaned, toolCalls, beforeFirst }
  }

  async execTool(call: ToolCall): Promise<ToolResult> {
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
    const body = JSON.stringify(result.data ?? null)
    const label = `<tool_result name="${result.name}" success="${result.success}">`
    if (result.error) {
      return `${label}\nerror: ${result.error}\n</tool_result>`
    }
    const truncated = body.length > 2000 ? body.slice(0, 2000) + "..." : body
    return `${label}\n${truncated}\n</tool_result>`
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
