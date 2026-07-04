/**
 * RwkvEngineAdapter — prompt building, grammar generation, and tool-call
 * parsing for RWKV models. See ARCH.md §"Engine + Adapter" (A11).
 *
 * This adapter is RWKV-specific. Other models would get their own adapter
 * that speaks the same interface but with different BNF / token rules.
 */

import type { ToolDef, ToolCall } from "../types.ts"
import { toolsToGbnfWithThink, toolsToGbnf } from "../tools/registry.ts"
import { getFormatConfig } from "../agents/format-config.ts"
import { clean, fixToolCallJson } from "./adapter-utils.ts"

export interface BuildPromptOpts {
  systemPrompt: string
  history: string
  userInput: string
  sep: string
  assistantRole: string
  thinkSuffix?: string
}

export interface BuildGrammarOpts {
  tools: ToolDef[]
  /** If true, allow think blocks in the grammar (default). */
  allowThink?: boolean
}

export interface ParseCallsResult {
  text: string
  toolCalls: ToolCall[]
  beforeFirst: string
  errors: ToolCall[]
}

/**
 * Build a flat prompt string from system prompt + history + user input.
 * This is what `loop.ts` currently does inline at lines ~118-126.
 */
export function buildPrompt(opts: BuildPromptOpts): string {
  const cfg = getFormatConfig()
  const sep = opts.sep ?? cfg.sep
  const role = opts.assistantRole ?? cfg.assistantOpen
  const thinkSuffix = opts.thinkSuffix ?? ""
  return clean(
    opts.history +
      `${opts.userInput}${thinkSuffix}` +
      sep +
      role
  )
}

/**
 * Build a GBNF grammar string for the given tools.
 * Delegates to `toolsToGbnfWithThink` or `toolsToGbnf`.
 */
export function buildGrammar(opts: BuildGrammarOpts): string {
  if (opts.allowThink ?? true) {
    return toolsToGbnfWithThink(opts.tools)
  }
  return toolsToGbnf(opts.tools)
}

/**
 * Parse tool calls from raw model output.
 * Extracted from `loop.ts:233-309`.
 */
export function parseToolCalls(text: string): ParseCallsResult {
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
    } catch {
      errors.push({ name: "__parse_error__", args: { raw: text.slice(openPos, lastIndex) } })
    }
  }
  segments.push(text.slice(lastIndex))

  const beforeFirst = segments[0] ?? ""
  const cleaned = segments.join("").trim()

  return { text: cleaned, toolCalls, beforeFirst, errors }
}
