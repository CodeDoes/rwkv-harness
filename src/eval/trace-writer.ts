import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { ToolResult } from "../types.ts"
import { formatToolResult } from "../agent/loop.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TRACES_DIR = path.resolve(__dirname, "..", "eval", ".traces")

export class TraceWriter {
  private filePath: string
  private fd: number | null = null

  constructor(mode: string) {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    this.filePath = path.join(TRACES_DIR, `${mode}-${ts}.txt`)
  }

  open() {
    this.fd = fs.openSync(this.filePath, "a")
    this.emit(`=== ${path.basename(this.filePath, ".txt")} ===`)
    this.emit(`start: ${new Date().toISOString()}`)
    this.emit("")
    return this
  }

  private emit(line: string) {
    if (this.fd !== null) {
      fs.writeSync(this.fd, line + "\n")
    }
  }

  infoAbout(label: string, data: Record<string, string>) {
    this.emit("")
    this.emit(`--- ${label} ---`)
    for (const [k, v] of Object.entries(data)) {
      this.emit(`  ${k}: ${v}`)
    }
  }

  infoSection(label: string) {
    this.emit("")
    this.emit(`--- ${label} ---`)
  }

  inputBlock(text: string) {
    this.emit("")
    this.emit(`--- input ---`)
    this.emit(text.replace(/\x03/g, "\\x03"))
  }

  outputBlock() {
    this.emit("")
    this.emit(`--- output ---`)
  }

  toolResultBlock(result: ToolResult) {
    this.emit("")
    this.emit(`--- tool-result ---`)
    this.emit(formatToolResult(result))
  }

  outputStream(text: string) {
    if (this.fd !== null) {
      fs.writeSync(this.fd, text.replace(/\x03/g, "\\x03"))
    }
  }

  verification(checks: { name: string; pass: boolean }[]) {
    this.emit("")
    this.emit(`── Verification ──`)
    for (const c of checks) {
      this.emit(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}`)
    }
    const passed = checks.filter((c) => c.pass).length
    const total = checks.length
    const status = passed === total ? "PASS" : "FAIL"
    this.emit(`${passed}/${total} ${status}`)
  }

  close() {
    if (this.fd !== null) {
      this.emit("")
      this.emit(`end: ${new Date().toISOString()}`)
      fs.closeSync(this.fd)
      this.fd = null
    }
  }

  get path(): string {
    return this.filePath
  }
}
