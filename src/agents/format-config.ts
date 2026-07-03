/**
 * Central turn-format / response-format configuration.
 *
 * Single source of truth for everything that controls the prompt shape:
 *  - separator between turns (`SEP`)
 *  - generation stop sequences (`STOP_SEQ`)
 *  - role markers (`User:`, `Assistant:`)
 *  - tool-response tag style (`<tool_response>…</tool_response>`) and placement
 *    (`"block"` — own user turn | `"inline"` — glued onto the `</tool_call>`)
 *  - subagent wrapper (`<subagent name="…">…</subagent>` around the per-agent
 *    trace block)
 *  - body indentation rule (every body line carries a leading `\t`)
 *
 * Override via environment variables for live experiments without rebuild:
 *
 *   SEP=                        default "\n\n"
 *   STOP_SEQ="</tool_call>,User:,x03"   comma-separated
 *   TOOL_RESPONSE_PLACEMENT=block|inline
 *   SUBAGENT_WRAP=xml|none
 *   INDENT_STYLE=all-indented|tags-flush
 *
 * Code reads `getFormatConfig()` — never the constants directly.
 */

export type ToolResponsePlacement = "block" | "inline"

export type ToolResponseTagStyle = "default" | "bare" | "indent-stripped"

export type SubagentWrap = "xml" | "none"

export type RoleMarker = "User:" | "Assistant:"

export interface StopSequences {
  readonly primary: string
  readonly list: string[]
}

export interface FormatConfig {
  /** Blank-line indicator inserted between prompt turns. */
  readonly sep: string
  /** Generation stop sequences. First entry is the primary stop. */
  readonly stops: StopSequences
  /** Role marker prefixes. */
  readonly userOpen: RoleMarker
  readonly assistantOpen: RoleMarker
  /** Tool-response tag controls. */
  readonly toolResponse: {
    readonly openTag: string
    readonly closeTag: string
    readonly placement: ToolResponsePlacement
  }
  /** Subagent wrapping for eval traces / multi-agent prompts. */
  readonly subagentWrap: SubagentWrap
  /** Body indentation style. */
  readonly indentStyle: "all-indented" | "tags-flush"
  /** Tool-result payload truncation length (chars). */
  readonly toolResultMaxChars: number
}

function readEnv(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

function resolveToolResponsePlacement(env?: string): ToolResponsePlacement {
  return env === "inline" ? "inline" : "block"
}

function resolveSubagentWrap(env?: string): SubagentWrap {
  return env === "xml" ? "xml" : "none"
}

function resolveIndentStyle(env?: string): "all-indented" | "tags-flush" {
  return env === "tags-flush" ? "tags-flush" : "all-indented"
}

function resolveSep(env?: string): string {
  if (!env) return "\n\n"
  if (env === "\\x00") return "\x00"
  return env
}

function resolveStops(env?: string): StopSequences {
  const defaultList = ["</tool_call>", "\n\nUser:", "\x03"]
  if (!env) return { primary: defaultList[0], list: [...defaultList] }
  const parsed = env.split(",").map((s) => {
    const trimmed = s.trim()
    if (trimmed === "x03") return "\x03"
    if (trimmed === "User:") return "\n\nUser:"
    return trimmed
  })
  return { primary: parsed[0] ?? defaultList[0], list: parsed }
}

let cached: FormatConfig | null = null

export function getFormatConfig(): FormatConfig {
  if (cached) return cached
  cached = Object.freeze({
    sep: resolveSep(readEnv("SEP")),
    stops: Object.freeze(resolveStops(readEnv("STOP_SEQ"))),
    userOpen: "User:",
    assistantOpen: "Assistant:",
    toolResponse: Object.freeze({
      openTag: "<tool_response>",
      closeTag: "</tool_response>",
      placement: resolveToolResponsePlacement(readEnv("TOOL_RESPONSE_PLACEMENT")),
    }),
    subagentWrap: resolveSubagentWrap(readEnv("SUBAGENT_WRAP")),
    indentStyle: resolveIndentStyle(readEnv("INDENT_STYLE")),
    toolResultMaxChars: 2000,
  }) as FormatConfig
  return cached
}

/** Test-only: rebuild the cached config (e.g. after a process env change). */
export function resetFormatConfig(): void {
  cached = null
}

/// ── Render helpers ─────────────────────────────

export function tag(name: string, style?: "all-indented" | "tags-flush"): string {
  return (style ?? getFormatConfig().indentStyle) === "all-indented" ? `\t${name}` : name
}

export function indentContent(content: string): string {
  return content.replace(/\n/g, "\n\t")
}

export const applyIndentRule = (content: string): string => indentContent(content)

export interface ToolResultLike {
  name: string
  success: boolean
  data?: unknown
  error?: string
}

/** Tool-response payload (JSON), truncated to `FORMAT_CONFIG.toolResultMaxChars`. */
export function renderToolResponsePayload(result: ToolResultLike): string {
  const cfg = getFormatConfig()
  const payload = result.success && !result.error
    ? { name: result.name, result: result.data ?? { success: true } }
    : { name: result.name, result: { success: false, error: result.error } }
  const body = JSON.stringify(payload)
  return body.length > cfg.toolResultMaxChars
    ? body.slice(0, cfg.toolResultMaxChars) + "..."
    : body
}

/** `<tool_response>…</tool_response>` block (with body indentation) — used in both block and inline placement. */
export function renderToolResponseBlock(result: ToolResultLike): string {
  const cfg = getFormatConfig()
  const open = tag(cfg.toolResponse.openTag)
  const close = tag(cfg.toolResponse.closeTag)
  const body = renderToolResponsePayload(result)
  return `${open}\n\t${indentContent(body)}\n${close}`
}

/** Wrap a subagent's body in `<subagent name="…">…</subagent>` per config, otherwise return the body unchanged. */
export function wrapSubagent(name: string, body: string): string {
  const cfg = getFormatConfig()
  if (cfg.subagentWrap !== "xml") return body
  return `<subagent name="${name}">\n${body}\n</subagent>`
}

export function formatAssistantRole(): string {
  return getFormatConfig().assistantOpen
}

export function formatUserRole(): string {
  return getFormatConfig().userOpen
}

/** User-role prefix that precedes a tool-response block in `"block"` placement. */
export function formatToolResponseRole(): string {
  return `${formatUserRole()}\n`
}
