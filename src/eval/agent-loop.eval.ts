#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { EvalController, type Check } from "./eval-controller.ts"
import { AgentLoop } from "../agents/loop.ts"
import { Session } from "../session/session.ts"
import { SessionManager } from "../session/session-manager.ts"
import { type ToolDef } from "../types.ts"
import { TraceWriter } from "./trace-writer.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { fileURLToPath } from "url"

const PROJECT_ROOT = path.resolve(__dirname, "../..")

function makeToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>`
}

function think(content: string): string {
  return `<think>${content}</think>\n`
}

// ── Test 1: Tool call stops generation and tool result is fed back ──
async function testToolCallStops(baseDir: string): Promise<boolean> {
  console.error("\n── Test: tool call stops generation ──")

  const trace = new TraceWriter("toolcall").open()
  const model = EvalController.createMockModel([
    think("Need to read the file.") + makeToolCall("read", { path: "test.txt" }),
    think("Got the content.") + "The file contains: hello world.",
  ])

  const mgr = new SessionManager(baseDir, "toolcall-test", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })

  const agentLoop = new AgentLoop(model, session, 3, { saveSession: () => mgr.saveFromSession(session) })

  const output = await agentLoop.run("read test.txt", {})

  const checks: Check[] = [
    { name: "tool call triggered stop", pass: output.includes("hello world") },
    { name: "tool result in output", pass: output.includes("The file contains") },
    { name: "two mock responses consumed", pass: model.callCount === 2 },
  ]

  const allPass = EvalController.reportVerification("Tool Call Stop Test", checks, trace)
  trace.close()
  return allPass
}

// ── Test 2: Plain text signals end of turn ──
async function testPlainTextEnd(baseDir: string): Promise<boolean> {
  console.error("\n── Test: plain text signals end of turn ──")

  const trace = new TraceWriter("plain-end").open()
  const model = EvalController.createMockModel([
    think("I have no tools to use.") + "I have completed the task.",
  ])

  const mgr = new SessionManager(baseDir, "eot-test", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })

  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("do something simple")

  const checks: Check[] = [
    { name: "output contains model response", pass: output.includes("completed the task") },
    { name: "no extra iterations (plain text breaks loop)", pass: model.callCount === 1 },
  ]

  const allPass = EvalController.reportVerification("Plain Text End", checks, trace)
  trace.close()
  return allPass
}

// ── Test 3: MaxTokens cutoff returns what we have ──
async function testMaxTokensCutoff(baseDir: string): Promise<boolean> {
  console.error("\n── Test: maxTokens cutoff returns partial output ──")

  const trace = new TraceWriter("maxtokens").open()
  const model = EvalController.createMockModel([
    "This is a long response that has no tool call and no EOT marker, so it should be cut off at maxTokens.\n\n" +
    "But since this is a mock model, it just returns the whole string at once. The agent loop should " +
    "detect no tool call and return the partial text.",
  ])

  const mgr = new SessionManager(baseDir, "maxtokens-test", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })

  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("write a long response")

  const checks: Check[] = [
    { name: "partial output returned", pass: output.length > 0 },
    { name: "only one mock call", pass: model.callCount === 1 },
  ]

  const allPass = EvalController.reportVerification("MaxTokens Cutoff Test", checks, trace)
  trace.close()
  return allPass
}

// ── Test 4: Multiple tool calls in sequence ──
async function testMultipleToolCalls(baseDir: string): Promise<boolean> {
  console.error("\n── Test: multiple sequential tool calls ──")

  const trace = new TraceWriter("multitool").open()
  const model = EvalController.createMockModel([
    think("First read the file.") + makeToolCall("read", { path: "a.txt" }),
    think("Now write output.") + makeToolCall("write", { path: "b.txt", content: "result" }),
    "Done with both operations.",
  ])

  const mgr = new SessionManager(baseDir, "multitool-test", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })

  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("read a.txt then write b.txt")

  const checks: Check[] = [
    { name: "all tool calls executed", pass: model.callCount === 3 },
    { name: "final output present", pass: output.includes("Done with both") },
  ]

  const allPass = EvalController.reportVerification("Multiple Tool Calls Test", checks, trace)
  trace.close()
  return allPass
}

// ── Test 5: Malformed tool call gets error feedback ──
async function testMalformedToolCall(baseDir: string): Promise<boolean> {
  console.error("\n── Test: malformed tool call gets error feedback ──")

  const trace = new TraceWriter("malformed").open()
  const model = EvalController.createMockModel([
    `<tool_call>\n{invalid json}\n</tool_call>`,
    think("Let me fix that.") + makeToolCall("read", { path: "test.txt" }),
    "Got the content.",
  ])

  const mgr = new SessionManager(baseDir, "malformed-test", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })

  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("read test.txt")

  const checks: Check[] = [
    { name: "model recovered from parse error", pass: output.includes("Got the content") || output.includes("fix") },
    { name: "three mock calls", pass: model.callCount === 3 },
  ]

  const allPass = EvalController.reportVerification("Malformed Tool Call Test", checks, trace)
  trace.close()
  return allPass
}

// ── Test 6: max_length resume continues truncated tool call ──
async function testMaxLengthResume(baseDir: string): Promise<boolean> {
  console.error("\n── Test: max_length resume continues truncated tool call ──")

  const trace = new TraceWriter("maxlength-resume").open()

  const longContent = "A".repeat(2000)
  const fullToolCall = makeToolCall("write", { path: "long.txt", content: longContent })

  // Use a truncation limit that splits the tool call across 2 generations
  const model = EvalController.createMockModel([
    fullToolCall,
    "Done writing.",
  ], 1500)

  const mgr = new SessionManager(baseDir, "maxlength-resume-test", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })

  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("write long.txt with lots of As")

  const fileExists = fs.existsSync("long.txt")
  let fileContent = ""
  if (fileExists) {
    fileContent = fs.readFileSync("long.txt", "utf-8")
  }

  // Verify continuation prompt was empty (key fix: don't re-feed partial output)
  const continuationPrompt = model.prompts[1] ?? "<no prompt>"

  const checks: Check[] = [
    { name: "tool call truncated and resumed (>2 mock calls)", pass: model.callCount >= 3 },
    { name: "file was written by resumed tool call", pass: fileExists },
    { name: "file content matches full length", pass: fileContent.length === 2000 },
    { name: "output contains done message", pass: output.includes("Done writing") },
    { name: "continuation prompt is empty (no double-feed)", pass: continuationPrompt === "" },
  ]

  const allPass = EvalController.reportVerification("MaxLength Resume Test", checks, trace)
  trace.close()
  return allPass
}

// ── Main ──
async function main(): Promise<number> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-agent-"))
  console.error(`Base dir: ${baseDir}`)

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const results = await Promise.all([
    testToolCallStops(baseDir).catch(e => { console.error("Tool call test error:", e); return false }),
    testPlainTextEnd(baseDir).catch(e => { console.error("Plain text end error:", e); return false }),
    testMaxTokensCutoff(baseDir).catch(e => { console.error("MaxTokens test error:", e); return false }),
    testMultipleToolCalls(baseDir).catch(e => { console.error("Multi tool test error:", e); return false }),
    testMalformedToolCall(baseDir).catch(e => { console.error("Malformed test error:", e); return false }),
    testMaxLengthResume(baseDir).catch(e => { console.error("MaxLengthResume test error:", e); return false }),
  ])

  process.chdir(originalCwd)
  fs.rmSync(baseDir, { recursive: true, force: true })

  const success = results.every(r => r)
  console.error(`\n── Agent Loop Eval ──`)
  console.error(`${results.filter(r => r).length}/${results.length} PASS`)
  console.log(success ? "EVAL PASSED" : "EVAL FAILED")
  return success ? 0 : 1
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("Eval error:", err)
  process.exit(1)
})
