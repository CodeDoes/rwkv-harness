#!/usr/bin/env node
import { LocalInferenceClient, LocalServerControl } from "./client.ts"
import { MockModel } from "../eval/mock-engine.ts"

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) pass++; else fail++
  console.log(`  ${cond ? "[PASS]" : "[FAIL]"} ${name}`)
}

// ── LocalServerControl ──

const ctrl = new LocalServerControl()
check("server starts stopped", !(await ctrl.isRunning()))

const engine = new MockModel(["mock response"])
ctrl.setEngine(engine)
check("server reports running after engine set", await ctrl.isRunning())

const status = await ctrl.status()
check("status has stateSize", typeof status.stateSize === "number")

// ── LocalInferenceClient ──

const client = new LocalInferenceClient(engine, "/tmp")

const { cacheId } = await client.cacheCreate()
check("cache create returns string id", typeof cacheId === "string" && cacheId.length > 0)

const info = await client.cacheGet(cacheId)
check("cache get returns info", info.found === true)

const listed = await client.cacheList()
check("cache list has 1 entry", listed.length === 1)

// ── generate ──

const result = await client.generate({
  cacheId,
  prompt: "hello",
  maxTokens: 5,
  temperature: 0.5,
})
check("generate returns text", typeof result.text === "string")
check("generate returns stopReason", typeof result.stopReason === "string")
check("generate returns cacheId", result.cacheId === cacheId)

// ── interrupt ──

const { stopped } = await client.interrupt(cacheId)
check("interrupt returns stopped", typeof stopped === "boolean")

// ── tokenize / detokenize ──

const tokens = await client.tokenize("hello")
check("tokenize returns array", Array.isArray(tokens))

const text = await client.detokenize(tokens)
check("detokenize returns string", typeof text === "string")

// ── Server events ──

let eventCount = 0
const unsub = ctrl.onEvent(() => { eventCount++ })
await ctrl.restart()
check("events fired during restart", eventCount > 0)
unsub()

// ── Summary ──

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
