#!/usr/bin/env node
import { parseFrontmatter, readFrontmatter } from "./frontmatter.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`) }
}

function main() {
  console.log("\n── frontmatter parse ──")
  const sample = "---\nthink: |\n  This is a thinker.\n  Two-line continuation.\n---\n# Body\n\nText here."
  const out = parseFrontmatter(sample)
  check("extracts think", out.think === "This is a thinker.\nTwo-line continuation.")
  check("extracts body", out.body.trim() === "# Body\n\nText here.")

  console.log("\n── no frontmatter ──")
  const plain = "# Just markdown\n\nNo frontmatter here."
  const out2 = parseFrontmatter(plain)
  check("no frontmatter → think=null", out2.think === null)
  check("body == original", out2.body === plain)

  console.log("\n── unrecognized field preserved as extra ──")
  const mixed = "---\nauthor: kit\nthink: |\n  The doc is about X.\n---\nthen body"
  const out3 = parseFrontmatter(mixed)
  check("think extracted", out3.think === "The doc is about X.")
  check("extra contains author", out3.extra.author === "kit")

  console.log("\n── CR-LF tolerated ──")
  const crlf = "---\r\nthink: |\r\n  crlf thinker.\r\n---\r\nbody"
  const out4 = parseFrontmatter(crlf)
  check("CRLF think works", out4.think === "crlf thinker.")
  check("CRLF body unshifts the frontmatter", out4.body === "body")

  console.log("\n── readFrontmatter handles missing file ──")
  const none = readFrontmatter("/nonexistent/path/file.md")
  check("missing file returns null", none === null)

  console.log(`\n${pass}/${pass + fail} PASS`)
  if (fail > 0) {
    console.log("\nFailures:")
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}
main()
