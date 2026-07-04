import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRACES_DIR = path.resolve(__dirname, "..", "eval", ".traces")

export type TraceRole = "system" | "user" | "assistant" | "tool" | "state-tune" | "meta"

export type TraceFormat = "inline" | "block"

/**
 * Trace output style. The block format reflects the inference layout:
 *   - `role:`    own line
 *   - `\t<line>` every body line (tags included — all tags tab-indented)
 *   - blank line between role blocks parallels `\n\n` SEP between blocks
 *
 * `inline` is the legacy single-line header form (`user: hello`).
 */
export type IndentStyle = "all-indented" | "tags-flush"

export interface TraceFormatOpts {
  /** Block (default) mirrors the inference prompt shape. */
  format?: TraceFormat
  /** Override the tag-indent style for this writer (defaults to env `INDENT_STYLE`, else "all-indented"). */
  indentStyle?: IndentStyle
}

const isAllIndented = (style: IndentStyle) => style === "all-indented"
const resolveStyle = (opts?: IndentStyle): IndentStyle => {
  if (opts) return opts
  const v = process.env.INDENT_STYLE?.trim()
  return v === "tags-flush" ? "tags-flush" : "all-indented"
}

export class TraceWriter {
  private filePath: string
  private fd: number | null = null
  private format: TraceFormat
  private indentStyle: IndentStyle
  private lineOpen = false

  constructor(mode: string, opts: TraceFormatOpts = {}) {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    this.filePath = path.join(TRACES_DIR, `${ts}_${mode}.txt`)
    this.format = opts.format ?? "block"
    this.indentStyle = resolveStyle(opts.indentStyle)
  }

  /** Tag formatting helper — kept here so the trace lines up with template output. */
  private tag(name: string): string {
    return isAllIndented(this.indentStyle) ? `\t${name}` : name
  }

  open(meta: Record<string, string> = {}) {
    this.fd = fs.openSync(this.filePath, "a")
    this.emit(`meta: ${new Date().toISOString()} ${path.basename(this.filePath, ".txt")}`)
    for (const [k, v] of Object.entries(meta)) {
      this.emit(`# ${k}: ${v}`)
    }
    this.emit("")
    return this
  }

  write(role: TraceRole, content: string) {
    if (role === "state-tune") return
    if (this.lineOpen) this.endLine()

    if (this.format === "inline") {
      const body = role === "tool"
        ? `<tool_response>\n${content}\n</tool_response>`
        : content
      this.emit(`${role}: ${body}`)
      if (role !== "meta") this.emit("")
      return
    }

    // Block format — mirrors the inference prompt.
    this.emit(`${role}:`)

    if (role === "tool") {
      this.emit(`${this.tag("<tool_response>")}`)
      this.emitIndented(content)
      this.emit(`${this.tag("</tool_response>")}`)
    } else {
      this.emitIndented(content)
    }

    if (role !== "meta") this.emit("")
  }

  /** Write a raw line (no role prefix) — for document-level wrappers like `<subagent>`. */
  raw(line: string) {
    if (this.fd === null) return
    if (this.lineOpen) this.endLine()
    this.emit(line)
    this.emit("")
  }

  verification(checks: { name: string; pass: boolean }[]) {
    this.emit("# verification")
    for (const c of checks) {
      this.emit(`[${c.pass ? "PASS" : "FAIL"}] ${c.name}`)
    }
    const passed = checks.filter((c) => c.pass).length
    const total = checks.length
    this.emit(`${passed}/${total} ${passed === total ? "PASS" : "FAIL"}`)
  }

  close() {
    if (this.fd !== null) {
      this.emit(`end: ${new Date().toISOString()}`)
      fs.closeSync(this.fd)
      this.fd = null
    }
  }

  get path(): string {
    return this.filePath
  }

  /**
   * Begin a new streaming line. If a previous line is still open (a prior
   * beginLine hasn't been endLine'd), commit it first so the new header
   * starts on its own line. The header is written verbatim — caller is
   * responsible for any leading `\n\t` if needed.
   */
  beginLine(header: string) {
    if (this.fd === null) return
    if (this.lineOpen) this.endLine()
    fs.writeSync(this.fd, header)
    fs.fsyncSync(this.fd)
    this.lineOpen = true
  }

  /** Append text to the current streaming line (kept for live-stream callers). */
  append(text: string) {
    if (this.fd === null) return
    if (!this.lineOpen) return
    if (!text) return
    fs.writeSync(this.fd, text)
    fs.fsyncSync(this.fd)
  }

  /** End the current streaming line. */
  endLine() {
    if (this.fd === null) return
    fs.writeSync(this.fd, "\n")
    fs.fsyncSync(this.fd)
    this.lineOpen = false
  }

  private emit(line: string) {
    if (this.fd === null) return
    fs.writeSync(this.fd, line + "\n")
    fs.fsyncSync(this.fd)
  }

  /**
   * Emit body so that every content line carries exactly one leading `\t`.
   * If the caller already included `\t` (template-style output), keep it; if not,
   * add one. Single source of truth for the rule is `example-template.ts`.
   */
  private emitIndented(body: string) {
    if (!body) { this.emit("\t"); return }
    const lines = body.split("\n")
    for (const line of lines) {
      if (line === "") {
        this.emit("\t")
      } else if (line.startsWith("\t")) {
        // Already tab-indented by the template — emit verbatim. Avoids
        // double-indented lines (`\t\t...`) that would look wrong.
        this.emit(line)
      } else {
        this.emit(`\t${line}`)
      }
    }
  }
}
