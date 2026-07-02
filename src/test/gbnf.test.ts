import GBNF from "gbnf"
import { toolsToGbnf, toolsToGbnfWithThink, toolsToGbnfZod } from "../tools/registry.ts"
import type { ToolDef } from "../types.ts"

export interface Check {
  name: string
  pass: boolean
  detail?: string
}

async function checkGramCompile(name: string, grammar: string): Promise<Check> {
  if (!grammar || grammar.length === 0) {
    return { name, pass: false, detail: "empty grammar" }
  }
  return { name, pass: true }
}

function checkInput(name: string, grammar: string, input: string, shouldPass: boolean): Check {
  try {
    GBNF(grammar, input)
    return { name, pass: shouldPass, detail: shouldPass ? undefined : "expected error but input was accepted" }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!shouldPass) return { name, pass: true, detail: msg.slice(0, 60) }
    return { name, pass: false, detail: msg.slice(0, 60) }
  }
}

/** Test old param-based GBNF compilation */
export async function testGbnfCompilation(defs: ToolDef[], label: string): Promise<Check[]> {
  const checks: Check[] = []
  checks.push(await checkGramCompile(`${label}: toolsToGbnf`, toolsToGbnf(defs)))
  checks.push(await checkGramCompile(`${label}: toolsToGbnfWithThink`, toolsToGbnfWithThink(defs)))
  return checks
}

/** Test Zod-based GBNF: compilation + input validation */
export async function testZodGbnf(defs: ToolDef[], label: string): Promise<Check[]> {
  const checks: Check[] = []
  let grammar: string

  // Compilation
  try {
    grammar = toolsToGbnfZod(defs)
    checks.push(await checkGramCompile(`${label}: toolsToGbnfZod`, grammar))
  } catch (e) {
    checks.push({ name: `${label}: toolsToGbnfZod`, pass: false, detail: String(e) })
    return checks
  }

  // Validate input matching against grammar
  for (const t of defs) {
    if (!t.schema) continue
    const args = t.parameters.map(p => {
      if (p.enum) return `"${p.enum[0]}"`
      return `"test"`
    })
    const argsStr = t.parameters.map((p, i) => `"${p.name}":${args[i]}`).join(",")
    const input = `<tool_call>{"name":"${t.name}","args":{${argsStr}}}</tool_call>`
    checks.push(checkInput(`${label}: valid ${t.name}`, grammar, input, true))
  }

  // Invalid name
  checks.push(checkInput(`${label}: rejects bad name`, grammar,
    `<tool_call>{"name":"invalidTool","args":{}}</tool_call>`, false))

  // Missing required
  if (defs[0]?.parameters.length) {
    const name = defs[0].name
    checks.push(checkInput(`${label}: rejects missing required`, grammar,
      `<tool_call>{"name":"${name}","args":{}}</tool_call>`, false))
  }

  // Escaped quotes
  if (defs[0]?.schema) {
    const first = defs[0]
    const escArgs = first.parameters.map(p => `"${p.name}":"hello \\"world\\""`).join(",")
    checks.push(checkInput(`${label}: accepts escaped quotes`,
      grammar, `<tool_call>{"name":"${first.name}","args":{${escArgs}}}</tool_call>`, true))
  }

  return checks
}

export function reportChecks(checks: Check[]): number {
  let pass = 0
  for (const c of checks) {
    const s = c.pass ? "PASS" : "FAIL"
    console.log(`  [${s}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
    if (c.pass) pass++
  }
  return pass
}
