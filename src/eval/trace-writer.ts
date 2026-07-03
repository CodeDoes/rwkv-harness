import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRACES_DIR = path.resolve(__dirname, "..", "eval", ".traces")

export type TraceRole = "system" | "user" | "assistant" | "tool" | "state-tune" | "meta"

export class TraceWriter {
  private filePath: string
  private fd: number | null = null

  constructor(mode: string) {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    this.filePath = path.join(TRACES_DIR, `${ts}_${mode}.txt`)
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
    let body = content
    if (role === "tool") {
      body = `<tool_response>\n${content}\n</tool_response>`
    }
    this.emit(`${role}: ${body}`)
    if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
      this.emit("")
    }
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

  /** Append raw text to current line (for streaming tokens) */
  append(text: string) {
    if (this.fd !== null) {
      fs.writeSync(this.fd, text)
      fs.fsyncSync(this.fd)
    }
  }

  /** End current streaming line */
  endLine() {
    if (this.fd !== null) {
      fs.writeSync(this.fd, "\n")
      fs.fsyncSync(this.fd)
    }
  }

  private emit(line: string) {
    if (this.fd !== null) {
      fs.writeSync(this.fd, line + "\n")
      fs.fsyncSync(this.fd)
    }
  }
}
