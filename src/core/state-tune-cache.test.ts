#!/usr/bin/env node
/**
 * Tests for state-tune cache.
 * The cache decision is "have I baked THIS exact content before?". We
 * verify:
 *  - hash is stable for identical inputs
 *  - hash changes when either input changes
 *  - set/has/clear/forget behave correctly
 *  - persistence round-trips through JSON
 *  - mutations to the in-memory cache are observable via reference
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { StateTuneCache } from "./state-tune-cache.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`) }
}

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stc-"))
}

function main() {
  console.log("\n── static hashing ──")
  const h1 = StateTuneCache.hash("system-A", "examples-XYZ")
  const h1b = StateTuneCache.hash("system-A", "examples-XYZ")
  check("identical input → same hash", h1 === h1b)
  check("hash is 64 hex (sha256)", /^[0-9a-f]{64}$/.test(h1))

  const h2 = StateTuneCache.hash("system-A", "examples-XYZ!")
  check("changing append changes hash", h1 !== h2)
  const h3 = StateTuneCache.hash("system-B", "examples-XYZ")
  check("changing system changes hash", h1 !== h3)
  const h4 = StateTuneCache.hash(undefined, "examples-XYZ")
  check("undefined system still hashes", h4 !== h1 && /^[0-9a-f]{64}$/.test(h4))
  const h5 = StateTuneCache.hash("system-A", undefined)
  check("undefined append still hashes", /^[0-9a-f]{64}$/.test(h5))

  console.log("\n── in-memory cache ──")
  const cache = new StateTuneCache({ persistDir: null })
  check("starts empty", cache.size() === 0)
  check("missing hash returns false", !cache.has("nothere"))
  cache.set("abc", { bytes: 100 })
  check("set then has", cache.has("abc"))
  check("set then size=1", cache.size() === 1)
  cache.forget("abc")
  check("forget clears it", !cache.has("abc"))
  cache.set("a", { bytes: 1 })
  cache.set("b", { bytes: 2 })
  cache.clear()
  check("clear empties everything", cache.size() === 0)

  console.log("\n── persistence round-trip ──")
  const dir = freshDir()
  try {
    const a = new StateTuneCache({ persistDir: dir })
    a.set("h1", { bytes: 12 })
    a.set("h2", { bytes: 34 })
    check("a persists 2 entries", a.size() === 2)

    const b = new StateTuneCache({ persistDir: dir })
    check("b loads 2 entries on construction", b.size() === 2)
    check("b has h1", b.has("h1"))
    check("b has h2", b.has("h2"))

    b.clear()
    const c = new StateTuneCache({ persistDir: dir })
    check("c sees cleared state on next load", c.size() === 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log("\n── corrupt-cache fallback ──")
  const dir2 = freshDir()
  try {
    const file = path.join(dir2, "state-tune.baked.json")
    fs.writeFileSync(file, "NOT VALID JSON", "utf-8")
    const cache = new StateTuneCache({ persistDir: dir2 })
    check("corrupt file → empty cache, no throw", cache.size() === 0)
    cache.set("x", { bytes: 1 })
    check("can still write after corrupt load", cache.has("x"))
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true })
  }

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main()
