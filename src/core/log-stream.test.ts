#!/usr/bin/env node
/**
 * Tests for LogStream. The behavior is intentionally small:
 *  - lines are forwarded to the chosen mirror (or no mirror)
 *  - lines are appended to a file when `path:` is set, with newlines
 *  - close() releases the file descriptor
 *  - emits don't error on missing file path
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { LogStream } from "./log-stream.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`) }
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ls-"))
}

function readAll(p: string): string {
  return fs.readFileSync(p, "utf-8")
}

function main() {
  console.log("\n── file-only stream ──")
  const dir = freshDir()
  try {
    const file = path.join(dir, "x.log")
    const lg = new LogStream({ path: file, mirror: "none" })
    lg.info("hello")
    lg.info("world")
    lg.close()
    const text = readAll(file)
    check("file has 'hello'", text.includes("hello"))
    check("file has 'world'", text.includes("world"))
    check("each line newline-terminated", text.split("\n").filter((l) => l.trim().length > 0).length === 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }

  console.log("\n── prefix ──")
  const dir2 = freshDir()
  try {
    const file = path.join(dir2, "x.log")
    const lg = new LogStream({ path: file, mirror: "none", prefix: "[eval] " })
    lg.info("hi")
    lg.close()
    check("prefix prepended", readAll(file).includes("[eval] hi"))
  } finally { fs.rmSync(dir2, { recursive: true, force: true }) }

  console.log("\n── close() is idempotent w/ no fd ──")
  const lg = new LogStream()
  lg.close()
  lg.close()
  check("closing a no-fd stream does not throw", true)

  console.log("\n── multi-call accumulates ──")
  const dir3 = freshDir()
  try {
    const file = path.join(dir3, "x.log")
    const lg = new LogStream({ path: file, mirror: "none" })
    for (let i = 0; i < 5; i++) lg.info(`line ${i}`)
    lg.close()
    check("five lines persisted",
      readAll(file).split("\n").filter((l) => l.trim().length > 0).length === 5,
    )
  } finally { fs.rmSync(dir3, { recursive: true, force: true }) }

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main()
