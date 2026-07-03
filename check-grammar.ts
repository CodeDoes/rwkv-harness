import { toolsToGbnfWithThink } from "./src/tools/registry.ts"
import { toolDefs as storytellerToolDefs } from "./src/agents/storyteller/tools/index.ts"
import { toolDefs as envoyToolDefs } from "./src/agents/envoy/tools/index.ts"

// Print the full grammar for each
console.log("=== storyteller grammar ===")
console.log(toolsToGbnfWithThink(storytellerToolDefs))
console.log("\n=== envoy grammar ===")
console.log(toolsToGbnfWithThink(envoyToolDefs))

// Now try to compile with schoolmarm
async function test() {
  const schoolmarm = await import("schoolmarm")
  const Grammar = schoolmarm.Grammar
  const GrammarState = schoolmarm.GrammarState

  for (const [name, defs] of [["storyteller", storytellerToolDefs], ["envoy", envoyToolDefs]] as const) {
    const gbnf = toolsToGbnfWithThink(defs)
    try {
      const g = Grammar.new(gbnf)
      console.log(`\n${name}: Grammar compiled OK`)
      const gs = GrammarState.new(g.clone())
      console.log(`${name}: GrammarState created OK`)
      // Test allowed tokens
      const testTokens = [
        "hello", " world", "<think>", "</think>", "<tool_call>", "</tool_call>",
        '{"name":"write","arguments":{"path":"test","content":"hello"}}',
        "\n\nUser:", "\x03",
      ]
      const allowed = gs.allowed_tokens(testTokens)
      for (let i = 0; i < testTokens.length; i++) {
        console.log(`  ${allowed[i] ? "ALLOW" : "DENY"}: ${JSON.stringify(testTokens[i])}`)
      }
    } catch (e) {
      console.error(`\n${name}: ERROR: ${e}`)
    }
  }
}
test().catch(console.error)
