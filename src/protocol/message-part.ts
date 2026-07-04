/**
 * MessagePart — the canonical interchange format for prompt data that flows
 * between the harness and any inference adapter.
 *
 * Discriminated by `type`:
 *  - Prose parts (`system_instruction`, `user_message`, `think`, `text`) carry a
 *    plain string in `content`.
 *  - Structured parts (`tool_call`, `tool_response`) carry a `data` payload and
 *    have no `content` field by design (the split between `content` and `data`
 *    prevents ambiguity in render code that has to know whether a "body" is
 *    prose or JSON).
 *
 * ARCH.md §"Type hierarchy".
 */

/// ── Parts ──

export interface ProsePart {
  type: "system_instruction" | "user_message" | "think" | "text"
  content: string
}

export interface ToolCallPart {
  type: "tool_call"
  data: { name: string; arguments: Record<string, unknown> }
}

export interface ToolResponsePart {
  type: "tool_response"
  data: { name: string; success: boolean; data?: unknown; error?: string }
}

export type MessagePart = ProsePart | ToolCallPart | ToolResponsePart

export type ProsePartType = ProsePart["type"]
export type MessagePartType = MessagePart["type"]

export type ContentOf<T extends ProsePartType> = Extract<MessagePart, { type: T }>["content"]

/// ── Type guards ──

export function isProsePart(p: MessagePart): p is ProsePart {
  return p.type !== "tool_call" && p.type !== "tool_response"
}

export function isToolPart(p: MessagePart): p is ToolCallPart | ToolResponsePart {
  return p.type === "tool_call" || p.type === "tool_response"
}

/// ── Constructors ──

export const MessagePart = {
  system: (content: string): MessagePart => ({ type: "system_instruction", content }),
  user:   (content: string): MessagePart => ({ type: "user_message",     content }),
  think:  (content: string): MessagePart => ({ type: "think",            content }),
  text:   (content: string): MessagePart => ({ type: "text",             content }),
  toolCall: (name: string, args: Record<string, unknown>): ToolCallPart =>
    ({ type: "tool_call", data: { name, arguments: args } }),
  toolResponse: (name: string, success: boolean, data?: unknown, error?: string): ToolResponsePart =>
    ({ type: "tool_response", data: { name, success, data, error } }),
} as const

/// ── Templates (see ARCH.md §"Type hierarchy") ──

export interface MessagePartTemplate {
  /** Token(s) inserted before the part body. e.g. `"User: "`, `"\n\nUser:\n\t"`. */
  start: string
  /** Token(s) inserted between consecutive body lines. e.g. `"\n\t"`. */
  newline: string
  /** Token(s) inserted after the part body. e.g. `"\n\n"`, `"</tool_call>"`. */
  end: string
}

/**
 * `ResponseTemplate` carries one `MessagePartTemplate` per `MessagePart.type`.
 * Indexed by the union of `MessagePartType` so callers can look up a template
 * with the same key they got off the part.
 */
export interface ResponseTemplate {
  system_instruction: MessagePartTemplate
  user_message:       MessagePartTemplate
  think:              MessagePartTemplate
  text:               MessagePartTemplate
  tool_call:          MessagePartTemplate
  tool_response:      MessagePartTemplate
}

export function createMessagePartTemplate(t: { start: string; newline?: string; end: string }): MessagePartTemplate {
  return { start: t.start, newline: t.newline ?? "\n\t", end: t.end }
}

export function createResponseTemplate(t: ResponseTemplate): ResponseTemplate {
  return t
}

/** Look up the template for a given `MessagePart.type`. Just an indexed access. */
export function templateFor(tmpl: ResponseTemplate, type: MessagePartType): MessagePartTemplate {
  return tmpl[type]
}

/// ── Render a single part using its template ──

export function renderPart(part: MessagePart, tmpl: ResponseTemplate): string {
  const t = templateFor(tmpl, part.type)
  if (isProsePart(part)) {
    const body = part.content.replace(/\n/g, t.newline)
    return `${t.start}${body}${t.end}`
  }
  // structured: tool_call / tool_response — render JSON payload as the body
  const payload = JSON.stringify(part.data)
  const body = payload.replace(/\n/g, t.newline)
  return `${t.start}${body}${t.end}`
}

/** Render an entire context (a list of `MessagePart`s) into one prompt string. */
export function renderContext(parts: MessagePart[], tmpl: ResponseTemplate): string {
  return parts.map((p) => renderPart(p, tmpl)).join("")
}

/// ── Stop-reason enum (ARCH.md §"Type hierarchy") ──

export type StopReason = "stop" | "length" | "abort" | "interrupt" | "tool_call"
