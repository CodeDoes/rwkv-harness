/**
 * LogStream — a tiny tee helper.
 *
 * Lets callers write to a `LogStream` once, and have lines flow to:
 *   1. the original stream they attached at construction (typically
 *      `process.stdout` or `process.stderr`), and
 *   2. a file at `path` (when provided).
 *
 * Why: the eval suite and CLI already pipe their stdout/stderr into
 * `.eval.log`, `.gateway.log`, etc. via shell redirection. But
 * redistributed consumers (TUI, web dashboard) want a single in-process
 * sink they can read from, and we want stream output to also reach a
 * durable file even when `pnpm eval` is run without `>` redirection.
 *
 * Usage:
 *   const lg = new LogStream({ path: ".eval.log", mirror: "stdout" })
 *   lg.line("hello")         // → "hello\n" to stdout AND .eval.log
 *   lg.line({ level: "err" }, "boom")  // → "boom\n" to stderr + file
 *   lg.close()
 */
import * as fs from "fs"
import * as path from "path"

export type Mirror = "stdout" | "stderr" | "none"

export interface LogStreamOpts {
  /** Write here in addition to the mirror. File is opened in append mode. */
  path?: string
  /** Console stream to mirror to. Default "stdout". Pass "none" to file-only. */
  mirror?: Mirror
  /** Optional prefix prepended to every line (e.g. "[eval] "). */
  prefix?: string
}

export class LogStream {
  private filePath: string | null
  private mirror: Mirror
  private prefix: string
  private fd: number | null = null

  constructor(opts: LogStreamOpts = {}) {
    this.filePath = opts.path ?? null
    this.mirror = opts.mirror ?? "stdout"
    this.prefix = opts.prefix ?? ""
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      this.fd = fs.openSync(this.filePath, "a")
    }
  }

  /** Write one line (newline appended if missing). */
  line(...parts: Array<string | { level: Mirror } | undefined>): void {
    const filtered = parts.filter((p): p is string | { level: Mirror } => p !== undefined)
    let target: Mirror = this.mirror
    const segments: string[] = [this.prefix]
    for (const p of filtered) {
      if (typeof p === "string") segments.push(p)
      else target = p.level
    }
    const text = segments.join("") + (segments[segments.length - 1]?.endsWith("\n") ? "" : "\n")

    if (target === "stdout") process.stdout.write(text)
    else if (target === "stderr") process.stderr.write(text)

    if (this.fd !== null) {
      fs.writeSync(this.fd, text)
      fs.fsyncSync(this.fd)
    }
  }

  /** Shorthand for `line({level:"stderr"}, msg)`. */
  error(msg: string, ...extra: string[]): void {
    this.line({ level: "stderr" }, msg, ...extra)
  }

  /** Shorthand for `line(msg)` with mirror=stdout. */
  info(msg: string, ...extra: string[]): void {
    this.line(msg, ...extra)
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
  }

  get path(): string | null { return this.filePath }
}
