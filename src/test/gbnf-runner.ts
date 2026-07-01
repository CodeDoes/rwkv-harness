import { toolDefs } from "../tools/registry.ts"
import { testGbnfCompilation, testZodGbnf, reportChecks } from "./gbnf.test.ts"

async function main() {
  let checks: Awaited<ReturnType<typeof testGbnfCompilation>> = []

  // Default tool set
  console.log("── Default Tool Set ──")
  checks = checks.concat(await testGbnfCompilation(toolDefs, "default"))
  checks = checks.concat(await testZodGbnf(toolDefs, "default"))
  reportChecks(checks.slice(-15))

  // Storyteller
  try {
    const { toolDefs: stDefs } = await import("../agents/storyteller/tools/index.ts")
    console.log("\n── Storyteller Tool Set ──")
    checks = checks.concat(await testGbnfCompilation(stDefs, "storyteller"))
    checks = checks.concat(await testZodGbnf(stDefs, "storyteller"))
    reportChecks(checks.slice(-15))
  } catch (e) {
    console.log("\n── Storyteller ── SKIP:", e instanceof Error ? e.message : String(e))
  }

  // Envoy
  try {
    const { toolDefs: envDefs } = await import("../agents/envoy/tools/index.ts")
    console.log("\n── Envoy Tool Set ──")
    checks = checks.concat(await testGbnfCompilation(envDefs, "envoy"))
    checks = checks.concat(await testZodGbnf(envDefs, "envoy"))
    reportChecks(checks.slice(-15))
  } catch (e) {
    console.log("\n── Envoy ── SKIP:", e instanceof Error ? e.message : String(e))
  }

  const total = checks.length
  const passed = checks.filter(c => c.pass).length
  console.log(`\n${passed}/${total} PASS${passed === total ? "" : `, ${total - passed} FAIL`}`)
  process.exit(passed === total ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
