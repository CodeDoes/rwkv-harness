import type { MessagePart, ResponseTemplate } from "../protocol/message-part.ts"
import { renderContext } from "../protocol/message-part.ts"

/**
 * Session — client-side message-history container.
 * See ARCH.md §"Session" (A16-A18).
 *
 * This is a data class: it holds messages and configuration but does NOT
 * drive inference. `resume()` on the engine side orchestrates the generate →
 * parse → tool-exec → feedback loop (Phase 5).
 */
export class Session {
  readonly id: string
  readonly context: MessagePart[] = []
  cacheId: string | null = null
  agentName: string

  constructor(opts: { id: string; agentName: string; cacheId?: string | null }) {
    this.id = opts.id
    this.agentName = opts.agentName
    this.cacheId = opts.cacheId ?? null
  }

  /** Append one or more messages to the end of the context. */
  input(...parts: MessagePart[]): void {
    this.context.push(...parts)
  }

  /** Number of turns (assistant blocks) in the context. */
  get turnCount(): number {
    return this.context.filter((p) => p.type === "text" || p.type === "tool_call" || p.type === "tool_response").length
  }

  /** Last N messages (or all if N is less than 1). */
  last(n: number): MessagePart[] {
    if (n < 1) return [...this.context]
    return this.context.slice(-n)
  }

  /**
   * Fork: create a child Session whose context starts from the first N messages
   * of the parent. The child gets a new id; the parent's cacheId is NOT
   * inherited (the child starts cold).
   */
  fork(upToMessageIndex: number): Session {
    const child = new Session({
      id: `${this.id}_fork_${Date.now().toString(36)}`,
      agentName: this.agentName,
      cacheId: null,
    })
    child.context.push(...this.context.slice(0, upToMessageIndex))
    return child
  }

  /** Clean text of the last assistant turn for UIs / summaries. */
  get lastAssistantText(): string {
    const last = [...this.context].reverse()
    let text = ""
    for (const p of last) {
      if (p.type === "text") text = p.content + text
      else if (p.type === "tool_call" || p.type === "tool_response") break
    }
    return text
  }

  /** Render the full context into a single prompt string using a response template. */
  toPrompt(template: ResponseTemplate): string {
    return renderContext(this.context, template)
  }

  /** Serializable shape for JSONL / wire transfer. */
  toJSON(): SessionJSON {
    return {
      id: this.id,
      agentName: this.agentName,
      cacheId: this.cacheId,
      messages: this.context.map((p) => ({
        type: p.type,
        content: "content" in p ? (p as any).content : undefined,
        data: "data" in p ? (p as any).data : undefined,
      })),
    }
  }

  static fromJSON(json: SessionJSON): Session {
    const s = new Session({ id: json.id, agentName: json.agentName, cacheId: json.cacheId })
    for (const m of json.messages) {
      if (m.type === "tool_call") {
        s.context.push({ type: "tool_call", data: m.data as any })
      } else if (m.type === "tool_response") {
        s.context.push({ type: "tool_response", data: m.data as any })
      } else {
        s.context.push({ type: m.type as any, content: m.content ?? "" })
      }
    }
    return s
  }
}

export interface SessionJSON {
  id: string
  agentName: string
  cacheId: string | null
  messages: { type: string; content?: string; data?: unknown }[]
}
