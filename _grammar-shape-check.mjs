import { Grammar } from "schoolmarm"
import { toolsToGbnfWithThink } from "./src/tools/registry.ts"

const gbnf = toolsToGbnfWithThink()
const grammar = Grammar.parse(gbnf)
const rootRule = grammar.getRule("root")
console.log("Root rule RHS:")
console.log(rootRule.toString ? rootRule.toString() : JSON.stringify(rootRule))
console.log()
console.log("Full GBNF:")
console.log(gbnf)
