#!/usr/bin/env node
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { resolveWorkspace, workspaceModeFromEnv, cleanupWorkspace } from "./workspace.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`) }
}

function freshCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ws-"))
}

function main() {
  console.log("\n── live mode ──")
  const cwd = freshCwd()
  try {
    process.chdir(cwd)
    const r = resolveWorkspace({ mode: "live", slug: "dragon-tale" })
    check("live resolves under cwd", r.path === path.resolve(cwd, "workspace", "dragon-tale"))
    check("mode == live", r.mode === "live")
    check("dir exists", fs.statSync(r.path).isDirectory())
    // idempotent re-resolve: doesn't throw
    const r2 = resolveWorkspace({ mode: "live", slug: "dragon-tale" })
    check("re-resolve returns same path", r.path === r2.path)
  } finally { fs.rmSync(cwd, { recursive: true, force: true }) }

  console.log("\n── temp mode ──")
  const cwd2 = freshCwd()
  try {
    process.chdir(cwd2)
    const r = resolveWorkspace({ mode: "temp", slug: "session-A" })
    check("temp resolves under .tmp/workspace", r.path.startsWith(path.resolve(cwd2, ".tmp", "workspace")))
    check("mode == temp", r.mode === "temp")
    check("slug sanitized", r.slug === "session-a")
    check("dir exists", fs.statSync(r.path).isDirectory())
    cleanupWorkspace(r.path)
    check("cleanup removes it", !fs.existsSync(r.path))
  } finally { fs.rmSync(cwd2, { recursive: true, force: true }) }

  console.log("\n── slug safety ──")
  const cwd3 = freshCwd()
  try {
    process.chdir(cwd3)
    const r = resolveWorkspace({ mode: "live", slug: "../escape/attempt" })
    // `resolveWorkspace` should refuse to traverse out of the live root.
    check("slug sanitized to safe form", !r.path.includes(".."))
    check("still under live root", fs.existsSync(r.path))
    check("didn't create parent 'escape' dir",
      !fs.existsSync(path.resolve(cwd3, "escape")),
      `escape dir: ${path.resolve(cwd3, "escape")}`,
    )
  } finally { fs.rmSync(cwd3, { recursive: true, force: true }) }

  console.log("\n── baseDir override ──")
  const root = freshCwd()
  try {
    const r = resolveWorkspace({ mode: "live", slug: "x", baseDir: root })
    check("baseDir honored", r.path === path.join(root, "workspace", "x"))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }

  console.log("\n── slugify edge cases ──")
  const cwd4 = freshCwd()
  try {
    process.chdir(cwd4)
    const a = resolveWorkspace({ mode: "live", slug: "" })
    check("empty slug → anon", a.slug === "anon")
    const b = resolveWorkspace({ mode: "live", slug: "Capitalized Title" })
    check("slug lowercased", b.slug === "capitalized-title")
  } finally { fs.rmSync(cwd4, { recursive: true, force: true }) }

  console.log("\n── env + argv resolution ──")
  check("default mode is live", workspaceModeFromEnv({}, []) === "live")
  check("--ephemeral → temp", workspaceModeFromEnv({}, ["--ephemeral"]) === "temp")
  check("--workspace=live → live", workspaceModeFromEnv({}, ["--workspace=live"]) === "live")
  check("--workspace=temp → temp", workspaceModeFromEnv({}, ["--workspace=temp"]) === "temp")
  check("env WORKSPACE_MODE=temp → temp", workspaceModeFromEnv({ WORKSPACE_MODE: "temp" }, []) === "temp")
  check("env WORKSPACE_MODE=live → live", workspaceModeFromEnv({ WORKSPACE_MODE: "live" }, []) === "live")
  check("env bogus → live", workspaceModeFromEnv({ WORKSPACE_MODE: "wat" }, []) === "live")

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main()
