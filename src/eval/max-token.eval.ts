#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { EvalController, type Check } from "./eval-controller.ts"
import { AgentLoop } from "../agents/loop.ts"
import { Session } from "../session/session.ts"
import { SessionManager } from "../session/session-manager.ts"
import { TraceWriter } from "./trace-writer.ts"
import { type ToolCall, type ToolResult } from "../types.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function makeToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>`
}

function think(content: string): string {
  return `<think>${content}</think>\n`
}

// ── Test 1: Basic truncation — 1 continuation needed ──
async function testBasicTruncation(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Basic truncation (1 continuation) ──")

  const trace = new TraceWriter("basic-trunc").open()
  const longContent = "A".repeat(2000)
  const fullToolCall = makeToolCall("write", { path: "basic.txt", content: longContent })
  const model = EvalController.createMockModel([fullToolCall, "Done."], 1500)

  const mgr = new SessionManager(baseDir, "basic-trunc", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  let rawOutputCount = 0
  const output = await agentLoop.run("write basic.txt", {
    onRawOutput: () => { rawOutputCount++ },
  })

  const fileContent = fs.existsSync("basic.txt") ? fs.readFileSync("basic.txt", "utf-8") : ""
  const continuationPrompt = model.prompts[1] ?? "<no prompt>"

  const checks: Check[] = [
    { name: "3 mock calls (gen + continuation + done)", pass: model.callCount === 3 },
    { name: "file created", pass: fs.existsSync("basic.txt") },
    { name: "file content correct length", pass: fileContent.length === 2000 },
    { name: "output contains done", pass: output.includes("Done") },
    { name: "continuation prompt empty (no double-feed)", pass: continuationPrompt === "" },
    { name: "onRawOutput fires once per turn (no continuation separator)", pass: rawOutputCount === 2 },
  ]

  const allPass = EvalController.reportVerification("Basic Truncation", checks, trace)
  trace.close()
  return allPass
}

// ── Test 2: Multiple continuations (long content, needs 3 parts) ──
async function testMultiContinuation(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Multiple continuations (3 parts) ──")

  const trace = new TraceWriter("multi-cont").open()
  const longContent = "B".repeat(5000)
  const fullToolCall = makeToolCall("write", { path: "multi.txt", content: longContent })
  const model = EvalController.createMockModel([fullToolCall, "Wrote multi."], 2000)

  const mgr = new SessionManager(baseDir, "multi-cont", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("write multi.txt")

  const fileContent = fs.existsSync("multi.txt") ? fs.readFileSync("multi.txt", "utf-8") : ""

  // Count continuation calls (prompts that are empty string)
  const continuationCount = model.prompts.filter(p => p === "").length

  const checks: Check[] = [
    { name: "file created", pass: fs.existsSync("multi.txt") },
    { name: "file content correct length", pass: fileContent.length === 5000 },
    { name: "continuation calls present", pass: continuationCount >= 2 },
    { name: "output contains done", pass: output.includes("Wrote multi") },
  ]

  const allPass = EvalController.reportVerification("Multiple Continuations", checks, trace)
  trace.close()
  return allPass
}

// ── Test 3: Think block truncated, then tool call produced ──
async function testThinkThenTool(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Think block truncated, tool call in continuation ──")

  const trace = new TraceWriter("think-tool").open()

  // Response 1: think block that gets truncated (1200 chars of thinking)
  const longThink = think("A".repeat(1500))
  const toolPart = makeToolCall("write", { path: "think-tool.txt", content: "Hello World" })
  const fullResponse = longThink + toolPart
  const model = EvalController.createMockModel([fullResponse, "Done thinking."], 1000)

  const mgr = new SessionManager(baseDir, "think-tool", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("write think-tool.txt")

  const fileContent = fs.existsSync("think-tool.txt") ? fs.readFileSync("think-tool.txt", "utf-8") : ""

  const checks: Check[] = [
    { name: ">=3 mock calls", pass: model.callCount >= 3 },
    { name: "file created", pass: fs.existsSync("think-tool.txt") },
    { name: "file content correct", pass: fileContent === "Hello World" },
    { name: "output contains done", pass: output.includes("Done thinking") },
  ]

  const allPass = EvalController.reportVerification("Think Then Tool", checks, trace)
  trace.close()
  return allPass
}

// ── Test 4: Multiple tool calls, each truncated ──
async function testMultiToolTrunc(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Multiple tool calls, each truncated ──")

  const trace = new TraceWriter("multi-tool-trunc").open()
  const contentA = "AAAA".repeat(1000)
  const contentB = "BBBB".repeat(1000)
  const tc1 = makeToolCall("write", { path: "multi-a.txt", content: contentA })
  const tc2 = makeToolCall("write", { path: "multi-b.txt", content: contentB })
  const model = EvalController.createMockModel([
    think("Write first file.") + tc1,
    think("Write second file.") + tc2,
    "Both done.",
  ], 2000)

  const mgr = new SessionManager(baseDir, "multi-tool-trunc", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  await agentLoop.run("write two files")

  const fileA = fs.existsSync("multi-a.txt") ? fs.readFileSync("multi-a.txt", "utf-8") : ""
  const fileB = fs.existsSync("multi-b.txt") ? fs.readFileSync("multi-b.txt", "utf-8") : ""

  const checks: Check[] = [
    { name: ">=3 mock calls", pass: model.callCount >= 3 },
    { name: "file A created", pass: fs.existsSync("multi-a.txt") },
    { name: "file B created", pass: fs.existsSync("multi-b.txt") },
    { name: "file A correct length", pass: fileA.length === 4000 },
    { name: "file B correct length", pass: fileB.length === 4000 },
    { name: "no out-of-responses error", pass: model.callCount <= 8 },
  ]

  const allPass = EvalController.reportVerification("Multi Tool Truncation", checks, trace)
  trace.close()
  return allPass
}

// ── Test 5: Continuation bailout (content too long, exceeds bailout limit) ──
async function testBailoutLimit(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Continuation bailout (content exceeds limit) ──")

  const trace = new TraceWriter("bailout").open()

  // Extremely long single generation that needs many continuations
  const hugeContent = "C".repeat(50000)
  const fullToolCall = makeToolCall("write", { path: "bailout.txt", content: hugeContent })
  const model = EvalController.createMockModel([fullToolCall, "Never reached."], 2000)

  const mgr = new SessionManager(baseDir, "bailout", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("write huge file")

  const fileExists = fs.existsSync("bailout.txt")

  const checks: Check[] = [
    { name: "file NOT created (tool call never completed)", pass: !fileExists },
    { name: "bailout returns partial output", pass: output.length > 0 },
    { name: "bailout did NOT reach done message", pass: !output.includes("Never reached") },
    { name: "total model calls <= bailout limit + overhead", pass: model.callCount <= 12 },
  ]

  const allPass = EvalController.reportVerification("Bailout Limit", checks, trace)
  trace.close()
  return allPass
}

// ── Test 6: No truncation needed (content fits) ──
async function testNoTruncation(baseDir: string): Promise<boolean> {
  console.error("\n── Test: No truncation (content fits) ──")

  const trace = new TraceWriter("no-trunc").open()
  const shortContent = "Short content."
  const fullToolCall = makeToolCall("write", { path: "short.txt", content: shortContent })
  const model = EvalController.createMockModel([
    think("Easy.") + fullToolCall,
    "Done.",
  ], 10000)

  const mgr = new SessionManager(baseDir, "no-trunc", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("write short.txt")

  const fileContent = fs.existsSync("short.txt") ? fs.readFileSync("short.txt", "utf-8") : ""

  const checks: Check[] = [
    { name: "2 mock calls (no continuation needed)", pass: model.callCount === 2 },
    { name: "file created", pass: fs.existsSync("short.txt") },
    { name: "file content correct", pass: fileContent === "Short content." },
    { name: "no empty prompts (no continuation)", pass: model.prompts.every(p => p !== "") },
  ]

  const allPass = EvalController.reportVerification("No Truncation", checks, trace)
  trace.close()
  return allPass
}

// ── Test 7: Tool call JSON split exactly at boundary ──
async function testExactBoundary(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Tool call split exactly at JSON boundary ──")

  const trace = new TraceWriter("exact-boundary").open()

  // Craft a tool call where the truncation limit falls right in the middle
  // of the JSON content field
  const content = "X".repeat(876)
  const fullToolCall = makeToolCall("write", { path: "exact.txt", content })
  const model = EvalController.createMockModel([fullToolCall, "Done exact."], 500)

  const mgr = new SessionManager(baseDir, "exact-boundary", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  await agentLoop.run("write exact.txt")

  const fileContent = fs.existsSync("exact.txt") ? fs.readFileSync("exact.txt", "utf-8") : ""

  const checks: Check[] = [
    { name: "file created", pass: fs.existsSync("exact.txt") },
    { name: "file content correct length", pass: fileContent.length === 876 },
    { name: "file content correct", pass: fileContent === content },
  ]

  const allPass = EvalController.reportVerification("Exact Boundary", checks, trace)
  trace.close()
  return allPass
}

// ── Test 8: Think block retry — model thinks but doesn't call a tool ──
async function testThinkBlockRetry(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Think block retry (think without tool call) ──")

  const trace = new TraceWriter("think-retry").open()

  // Response 1: only a think block, no tool call → triggers retry
  const thinkOnly = think("I should think about what tool to use.")
  const toolPart = makeToolCall("write", { path: "think-retry.txt", content: "Retried successfully" })
  const thinkThenTool = think("Now I will call the tool.") + toolPart
  const model = EvalController.createMockModel([
    thinkOnly,
    thinkThenTool,
    "Done retry.",
  ])

  const mgr = new SessionManager(baseDir, "think-retry", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("write think-retry.txt")

  const fileContent = fs.existsSync("think-retry.txt") ? fs.readFileSync("think-retry.txt", "utf-8") : ""

  const checks: Check[] = [
    { name: "3 mock calls (think-only retry + think-then-tool + done)", pass: model.callCount === 3 },
    { name: "file created", pass: fs.existsSync("think-retry.txt") },
    { name: "file content correct", pass: fileContent === "Retried successfully" },
    { name: "output contains done", pass: output.includes("Done retry") },
    { name: "first prompt non-empty (initial request)", pass: model.prompts[0] !== "" },
    { name: "second prompt empty (retry with empty prompt)", pass: model.prompts[1] === "" },
  ]

  const allPass = EvalController.reportVerification("Think Block Retry", checks, trace)
  trace.close()
  return allPass
}

// ── Main ──
async function main(): Promise<number> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-max-token-"))
  console.error(`Base dir: ${baseDir}`)

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const results = await Promise.all([
    testBasicTruncation(baseDir).catch(e => { console.error("Basic truncation error:", e); return false }),
    testMultiContinuation(baseDir).catch(e => { console.error("Multi continuation error:", e); return false }),
    testThinkThenTool(baseDir).catch(e => { console.error("Think then tool error:", e); return false }),
    testMultiToolTrunc(baseDir).catch(e => { console.error("Multi tool trunc error:", e); return false }),
    testBailoutLimit(baseDir).catch(e => { console.error("Bailout limit error:", e); return false }),
    testNoTruncation(baseDir).catch(e => { console.error("No truncation error:", e); return false }),
    testExactBoundary(baseDir).catch(e => { console.error("Exact boundary error:", e); return false }),
    testThinkBlockRetry(baseDir).catch(e => { console.error("Think block retry error:", e); return false }),
  ])

  process.chdir(originalCwd)
  fs.rmSync(baseDir, { recursive: true, force: true })

  const success = results.every(r => r)
  console.error(`\n── Max-Token Eval ──`)
  console.error(`${results.filter(r => r).length}/${results.length} PASS`)
  console.log(success ? "EVAL PASSED" : "EVAL FAILED")
  return success ? 0 : 1
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("Eval error:", err)
  process.exit(1)
})
