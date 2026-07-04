import { type MessagePart, MessagePart as MP } from "../protocol/message-part.ts"
import type { Tool } from "../tools/tool.ts"
import { loadExampleEntries, type ExampleEntry } from "./example-template.ts"
import type { ToolHandler } from "../types.ts"

/**
 * Agent — tools + instructions + lazy state-tune examples.
 * See ARCH.md §"Agent" (A12-A14).
 */
export class Agent {
  readonly name: string
  readonly tools: Record<string, Tool>
  readonly instructions: string
  private _examplesCache: MessagePart[] | null = null

  constructor(opts: {
    name: string
    tools: Record<string, Tool>
    instructions: string
  }) {
    this.name = opts.name
    this.tools = opts.tools
    this.instructions = opts.instructions
  }

  /** Lazy-load and cache state-tune examples as MessagePart[]. */
  async getStateTuneExamples(): Promise<MessagePart[]> {
    if (this._examplesCache) return this._examplesCache
    const entries = loadExampleEntries(this.name)
    this._examplesCache = entries.map(exampleEntryToMessagePart)
    return this._examplesCache
  }

  /** Reset the example cache (e.g. after template/config change). */
  clearExampleCache(): void {
    this._examplesCache = null
  }

  /** Build a legacy handlers map from this agent's tools. */
  get legacyHandlers(): Record<string, ToolHandler> {
    const h: Record<string, ToolHandler> = {}
    for (const [name, tool] of Object.entries(this.tools)) {
      h[name] = async (args: Record<string, unknown>) => tool.exec(args)
    }
    return h
  }
}

/** Bridge an `ExampleEntry` (legacy) into a `MessagePart`. */
export function exampleEntryToMessagePart(e: ExampleEntry): MessagePart {
  switch (e.type) {
    case "system":
      return MP.system(e.content)
    case "user":
      return MP.user(e.content)
    case "think":
      return MP.think(e.content)
    case "text":
      return MP.text(e.content)
    case "tool_call": {
      const parsed = JSON.parse(e.content)
      return MP.toolCall(parsed.name as string, (parsed.arguments ?? parsed.args ?? {}) as Record<string, unknown>)
    }
    case "tool_response": {
      const parsed = JSON.parse(e.content)
      return MP.toolResponse(
        parsed.name as string,
        parsed.success !== false,
        parsed.data ?? parsed.result,
        parsed.error,
      )
    }
  }
}
