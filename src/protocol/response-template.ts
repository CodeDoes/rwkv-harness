/**
 * ResponseTemplate builder — derives a `ResponseTemplate` from the existing
 * `FormatConfig` (env-overridable). Keeps the FormatConfig as the single
 * source of truth for SEP / STOP_SEQ / placement / indent — see ARCH.md
 * §"Type hierarchy" (A8).
 *
 * For now this is a thin bridge: the actual formatting happens inside the
 * existing `format-config.ts` and `example-template.ts` helpers, which today
 * operate on `ExampleEntry` (a legacy name) rather than `MessagePart`. The
 * bridge doesn't replace them; it lets callers that already speak `MessagePart`
 * render through the same indentation / role-marker rules by mapping each
 * `MessagePart` type back to the `ExampleType` legacy key.
 */

import type { ResponseTemplate } from "./message-part.ts"
import {
  getFormatConfig,
  type FormatConfig,
} from "../agents/format-config.ts"
import { createMessagePartTemplate, createResponseTemplate } from "./message-part.ts"

/**
 * Legacy example-type keys. `format-config.ts` is built around these names;
 * we keep using them but bridge from `MessagePart.type`.
 */
export type LegacyExampleType =
  | "system"
  | "user"
  | "assistant"
  | "think"
  | "tool_call"
  | "tool_response"
  | "text"

function legacyKey(type: string): LegacyExampleType {
  switch (type) {
    case "system_instruction": return "system"
    case "user_message":       return "user"
    case "think":              return "think"
    case "text":               return "text"
    case "tool_call":          return "tool_call"
    case "tool_response":      return "tool_response"
    default: throw new Error(`Unknown MessagePart type: ${type}`)
  }
}

/**
 * Build a `ResponseTemplate` whose per-part start/newline/end come from the
 * legacy FormatConfig helpers (`formatUserRole`, `formatAssistantRole`,
 * `tag(...)`, `indentContent(...)`). The full formatting still goes through
 * the example-template's `format()` function — this builder just exposes
 * the same shape as a `ResponseTemplate` so that future code can call
 * `renderPart(part, template)` without going through examples.
 */
export function responseTemplateFromConfig(cfg: FormatConfig = getFormatConfig()): ResponseTemplate {
  const indent = cfg.indentStyle === "all-indented" ? "\n\t" : "\n"
  const userOpen = cfg.userOpen
  const assistantOpen = cfg.assistantOpen

  const tmplMap = {
    system_instruction: createMessagePartTemplate({ start: `${userOpen}\n`, newline: indent, end: "\n\n" }),
    user_message:       createMessagePartTemplate({ start: `${userOpen}\n`, newline: indent, end: "\n\n" }),
    assistant:          createMessagePartTemplate({ start: `${assistantOpen}\n`, newline: indent, end: "\n\n" }),
    think:              createMessagePartTemplate({ start: "\t<think>\n",  newline: indent, end: "\n\t</think>\n" }),
    text:               createMessagePartTemplate({ start: "", newline: indent, end: "\n" }),
    tool_call:          createMessagePartTemplate({ start: "\t<tool_call>\n", newline: indent, end: "\n\t</tool_call>\n" }),
    tool_response:      createMessagePartTemplate({
      start: cfg.toolResponse.placement === "inline" ? "" : `\t${cfg.toolResponse.openTag}\n`,
      newline: indent,
      end:    cfg.toolResponse.placement === "inline" ? "" : `\n\t${cfg.toolResponse.closeTag}\n`,
    }),
  }
  return createResponseTemplate(tmplMap as ResponseTemplate)
}

export { legacyKey }
