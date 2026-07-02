import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { ToolResult } from "../types.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRACES_DIR = path.resolve(__dirname, "..", "eval", ".traces")

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

  prompt(prompt: string) {
    this.emit(prompt)
  }

  output(raw: string) {
    if (this.fd !== null) {
      fs.writeSync(this.fd, raw.replace(/\x03/g, "\\x03"))
    }
    this.emit("")
  }

  toolResult(result: ToolResult) {
    const body = result.success && !result.error
      ? JSON.stringify({ name: result.name, result: result.data ?? { success: true } })
      : JSON.stringify({ name: result.name, result: { success: false, error: result.error } })
    const truncated = body.length > 2000 ? body.slice(0, 2000) + "..." : body
    this.emit(`<tool_response>\n${truncated}\n</tool_response>`)
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

  private emit(line: string) {
    if (this.fd !== null) {
      fs.writeSync(this.fd, line + "\n")
    }
  }
}
