#!/usr/bin/env node
import { Session } from "./session.ts"
import { MessagePart } from "../protocol/message-part.ts"

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) pass++; else fail++
  console.log(`  ${cond ? "[PASS]" : "[FAIL]"} ${name}`)
}

// ── Construction ──

const s = new Session({ id: "test-1", agentName: "envoy" })
check("session id", s.id === "test-1")
check("session agent", s.agentName === "envoy")
check("cacheId null", s.cacheId === null)
check("context empty", s.context.length === 0)
check("turnCount 0", s.turnCount === 0)

// ── input / append ──

s.input(MessagePart.user("hello"))
check("context length after 1 input", s.context.length === 1)
check("turnCount still 0 (user not a turn)", s.turnCount === 0)

s.input(MessagePart.text("hi there"))
check("context length after text", s.context.length === 2)

// ── fork ──

const child = s.fork(1)
check("child id different", child.id !== s.id)
check("child has 1 message", child.context.length === 1)
check("child's message is 'hello'", child.context[0].type === "user_message")
check("child cacheId is null", child.cacheId === null)
check("parent unchanged", s.context.length === 2)

// ── lastAssistantText ──

const s2 = new Session({ id: "test-2", agentName: "test" })
s2.input(MessagePart.user("do something"))
s2.input(MessagePart.think("let me check"))
s2.input(MessagePart.toolCall("read", { path: "/tmp/x" }))
s2.input(MessagePart.toolResponse("read", true, "content"))
s2.input(MessagePart.text("Found"))
s2.input(MessagePart.text(" the file."))
check("lastAssistantText returns last text block", s2.lastAssistantText === "Found the file.")

s2.input(MessagePart.toolCall("write", { path: "/tmp/y", content: "hi" }))
s2.input(MessagePart.toolResponse("write", true))
check("lastAssistantText empty after tool call (no trailing text)", s2.lastAssistantText === "")

// ── last(N) ──

const last2 = s2.last(2)
check("last(2) returns 2 parts", last2.length === 2)
check("last(2) most recent is tool_response", last2[1].type === "tool_response")

// ── toJSON / fromJSON round-trip ──

const json = s2.toJSON()
check("json has id", json.id === "test-2")
check("json has messages length", json.messages.length === 8)
const restored = Session.fromJSON(json)
check("restored agentName", restored.agentName === "test")
check("restored context length", restored.context.length === 8)
check("restored cacheId", restored.cacheId === null)
check("restored content matches", restored.context[4].type === "text" && (restored.context[4] as any).content === "Found")
check("restored tool_call data", restored.context[2].type === "tool_call" && (restored.context[2] as any).data.name === "read")

// ── Summary ──

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
