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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function makeToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>`
}

// ── Test 1: Empty generation bailout (4 empty responses) ──
async function testEmptyBailout(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Empty generation bailout ──")
  const trace = new TraceWriter("empty-bailout").open()
  const model = EvalController.createMockModel(["", "", "", ""])
  const mgr = new SessionManager(baseDir, "empty-bailout", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const checks: Check[] = [
    { name: "4 calls (initial + 3 retries before bailout)", pass: model.callCount === 4 },
    { name: "output is empty (bailout returns no text)", pass: output.length === 0 },
  ]
  const allPass = EvalController.reportVerification("Empty Bailout", checks, trace)
  trace.close()
  return allPass
}

// ── Test 2: Empty retry then tool call succeeds ──
async function testEmptyThenSuccess(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Empty retry then tool call ──")
  const trace = new TraceWriter("empty-then-success").open()
  const tc = makeToolCall("write", { path: "after-empty.txt", content: "Recovered" })
  const model = EvalController.createMockModel(["", tc, "Done."])
  const mgr = new SessionManager(baseDir, "empty-then-success", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const fileContent = fs.existsSync("after-empty.txt") ? fs.readFileSync("after-empty.txt", "utf-8") : ""
  const checks: Check[] = [
    { name: "3 calls (empty + tool + done)", pass: model.callCount === 3 },
    { name: "file created after empty retry", pass: fs.existsSync("after-empty.txt") },
    { name: "file content correct", pass: fileContent === "Recovered" },
    { name: "output contains done", pass: output.includes("Done") },
  ]
  const allPass = EvalController.reportVerification("Empty Then Success", checks, trace)
  trace.close()
  return allPass
}

// ── Test 3: Empty generation retry (same as test 1 pattern with tool call recovery) ──
async function testEmptyRetryRecovery(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Empty generation retry with recovery ──")
  const trace = new TraceWriter("empty-retry-recovery").open()
  const tc = makeToolCall("write", { path: "after-empty-recovery.txt", content: "Ok" })
  const model = EvalController.createMockModel(["", "", "", tc, "Done."])
  const mgr = new SessionManager(baseDir, "empty-retry-recovery", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const fileContent = fs.existsSync("after-empty-recovery.txt") ? fs.readFileSync("after-empty-recovery.txt", "utf-8") : ""
  const checks: Check[] = [
    { name: "5 calls (3 empty retries + tool + done)", pass: model.callCount === 5 },
    { name: "file created after empty retries", pass: fs.existsSync("after-empty-recovery.txt") },
    { name: "file content correct", pass: fileContent === "Ok" },
    { name: "output contains done", pass: output.includes("Done") },
  ]
  const allPass = EvalController.reportVerification("Empty Retry Recovery", checks, trace)
  trace.close()
  return allPass
}

// ── Test 4: Think block retry bailout (4 think blocks without tool) ──
async function testThinkBailout(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Think block retry bailout ──")
  const trace = new TraceWriter("think-bailout").open()
  const think1 = "<think>Thinking step 1</think>"
  const think2 = "<think>Thinking step 2</think>"
  const think3 = "<think>Thinking step 3</think>"
  const think4 = "<think>Thinking step 4</think>"
  const model = EvalController.createMockModel([think1, think2, think3, think4])
  const mgr = new SessionManager(baseDir, "think-bailout", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const checks: Check[] = [
    { name: "4 calls (3 think retries then bailout)", pass: model.callCount === 4 },
    { name: "output contains last think block text", pass: output.includes("Thinking step 4") },
  ]
  const allPass = EvalController.reportVerification("Think Bailout", checks, trace)
  trace.close()
  return allPass
}

// ── Test 5: Think block retry then tool call succeeds ──
async function testThinkThenTool(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Think block retry then tool call ──")
  const trace = new TraceWriter("think-then-tool").open()
  const thinkOnly = "<think>I should think about what tool to use.</think>"
  const thinkWithTool = "<think>Now I know.</think>\n" + makeToolCall("write", { path: "think-recovered.txt", content: "Success" })
  const model = EvalController.createMockModel([thinkOnly, thinkWithTool, "Done."])
  const mgr = new SessionManager(baseDir, "think-then-tool", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const fileContent = fs.existsSync("think-recovered.txt") ? fs.readFileSync("think-recovered.txt", "utf-8") : ""
  const checks: Check[] = [
    { name: "3 calls (think-only retry + think-tool + done)", pass: model.callCount === 3 },
    { name: "file created after think retry", pass: fs.existsSync("think-recovered.txt") },
    { name: "file content correct", pass: fileContent === "Success" },
    { name: "output contains done", pass: output.includes("Done") },
  ]
  const allPass = EvalController.reportVerification("Think Then Tool", checks, trace)
  trace.close()
  return allPass
}

// ── Test 6: Plain text end of turn (no tool call, no retry needed) ──
async function testPlainTextEnd(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Plain text end of turn ──")
  const trace = new TraceWriter("plain-end").open()
  const model = EvalController.createMockModel(["Final text."])
  const mgr = new SessionManager(baseDir, "plain-end", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const checks: Check[] = [
    { name: "1 call only (no retry)", pass: model.callCount === 1 },
    { name: "output is the text (not warning)", pass: output === "Final text." },
    { name: "output does NOT contain warning prefix", pass: !output.includes("[agent-loop]") },
  ]
  const allPass = EvalController.reportVerification("Plain Text End", checks, trace)
  trace.close()
  return allPass
}

// ── Test 7: End with \n\nUser: (user turn detection) ──
async function testEndWithUser(baseDir: string): Promise<boolean> {
  console.error("\n── Test: End with \\n\\nUser: ──")
  const trace = new TraceWriter("end-user").open()
  const model = EvalController.createMockModel(["Response.\n\nUser:Next request"])
  const mgr = new SessionManager(baseDir, "end-user", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const checks: Check[] = [
    { name: "1 call only (no retry)", pass: model.callCount === 1 },
    { name: "output contains user-referenced text", pass: output.includes("Response") },
    { name: "output does NOT contain warning prefix", pass: !output.includes("[agent-loop]") },
  ]
  const allPass = EvalController.reportVerification("End With User", checks, trace)
  trace.close()
  return allPass
}

// ── Test 8: Tool call JSON error ──
async function testToolCallError(baseDir: string): Promise<boolean> {
  console.error("\n── Test: Tool call JSON error ──")
  const trace = new TraceWriter("tool-error").open()
  const badJson = `<tool_call>\n{invalid json}\n</tool_call>`
  const goodCall = makeToolCall("write", { path: "after-error.txt", content: "Fixed" })
  const model = EvalController.createMockModel([badJson, goodCall, "Done."])
  const mgr = new SessionManager(baseDir, "tool-error", "agent")
  await mgr.ensureDir()
  const session = new Session({ id: mgr.sessionIdStr, agentName: "agent" })
  const agentLoop = new AgentLoop(model, session, 5, { saveSession: () => mgr.saveFromSession(session) })
  const output = await agentLoop.run("test")
  const fileContent = fs.existsSync("after-error.txt") ? fs.readFileSync("after-error.txt", "utf-8") : ""
  const checks: Check[] = [
    { name: "3 calls (bad JSON + good call + done)", pass: model.callCount === 3 },
    { name: "file created after error recovery", pass: fs.existsSync("after-error.txt") },
    { name: "file content correct", pass: fileContent === "Fixed" },
    { name: "output contains done", pass: output.includes("Done") },
  ]
  const allPass = EvalController.reportVerification("Tool Call Error", checks, trace)
  trace.close()
  return allPass
}

// ── Main ──
async function main(): Promise<number> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-loop-edge-"))
  console.error(`Base dir: ${baseDir}`)

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const results = await Promise.all([
    testEmptyBailout(baseDir).catch(e => { console.error("Empty bailout error:", e); return false }),
    testEmptyThenSuccess(baseDir).catch(e => { console.error("Empty then success error:", e); return false }),
    testEmptyRetryRecovery(baseDir).catch(e => { console.error("Empty retry recovery error:", e); return false }),
    testThinkBailout(baseDir).catch(e => { console.error("Think bailout error:", e); return false }),
    testThinkThenTool(baseDir).catch(e => { console.error("Think then tool error:", e); return false }),
    testPlainTextEnd(baseDir).catch(e => { console.error("Plain text end error:", e); return false }),
    testEndWithUser(baseDir).catch(e => { console.error("End with user error:", e); return false }),
    testToolCallError(baseDir).catch(e => { console.error("Tool call error:", e); return false }),
  ])

  process.chdir(originalCwd)
  fs.rmSync(baseDir, { recursive: true, force: true })

  const success = results.every(r => r)
  console.error(`\n── Loop Edge-Case Eval ──`)
  console.error(`${results.filter(r => r).length}/${results.length} PASS`)
  console.log(success ? "EVAL PASSED" : "EVAL FAILED")
  return success ? 0 : 1
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("Eval error:", err)
  process.exit(1)
})
