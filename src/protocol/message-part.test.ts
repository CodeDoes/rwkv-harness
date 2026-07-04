#!/usr/bin/env node
import {
  MessagePart,
  renderPart,
  renderContext,
  type MessagePart as MP,
  isProsePart,
  isToolPart,
  templateFor,
} from "./message-part.ts"
import { responseTemplateFromConfig } from "./response-template.ts"
import { resetFormatConfig } from "../agents/format-config.ts"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`) }
  console.log(`  ${cond ? "[PASS]" : "[FAIL]"} ${name}`)
}

resetFormatConfig()
process.env.INDENT_STYLE = "all-indented"
process.env.TOOL_RESPONSE_PLACEMENT = "block"
resetFormatConfig()

/// ── Prose / tool-part discrimination ──

{
  const parts: MP[] = [
    MessagePart.system("You are helpful."),
    MessagePart.user("hi"),
    MessagePart.think("hmm"),
    MessagePart.text("ok"),
    MessagePart.toolCall("ls", { path: "/tmp" }),
    MessagePart.toolResponse("ls", true, ["file1"]),
  ]
  check("system partition is prose", isProsePart(parts[0]))
  check("think partition is prose", isProsePart(parts[2]))
  check("tool_call is not prose", !isProsePart(parts[4]))
  check("tool_call is a tool part", isToolPart(parts[4]))
  check("tool_response is a tool part", isToolPart(parts[5]))
}

/// ── templateFor mapping ──

{
  const tmpl = responseTemplateFromConfig()
  for (const t of ["system_instruction", "user_message", "think", "text", "tool_call", "tool_response"] as const) {
    const tpl = templateFor(tmpl, t)
    const allStrings = typeof tpl.start === "string" && typeof tpl.newline === "string" && typeof tpl.end === "string"
    check(`templateFor(${t}) has string start/newline/end`, allStrings)
  }
}

/// ── renderPart produces non-empty string with indent applied ──

{
  const tmpl = responseTemplateFromConfig()
  const rendered = renderPart(MessagePart.text("hello\nworld"), tmpl)
  check("renderPart inserts tab after \\n for prose", rendered.includes("hello\n\tworld"))
  check("renderPart wraps with template.start/end", rendered.startsWith(tmpl.text.start) && rendered.endsWith(tmpl.text.end))
}

/// ── tool_call JSON is escaped with \\n when body has newlines ──

{
  const tmpl = responseTemplateFromConfig()
  const rendered = renderPart(MessagePart.toolCall("write", { path: "/tmp/a", content: "line1\nline2" }), tmpl)
  check("tool_call body stays single-line (JSON no-newline)", !rendered.includes("line1\nline2"))
  check("tool_call body is parseable JSON", (() => {
    const start = tmpl.tool_call.start.length
    const endIdx = rendered.length - tmpl.tool_call.end.length
    try { JSON.parse(rendered.slice(start, endIdx)); return true } catch { return false }
  })())
}

/// ── ToolResponse carries success flag ──

{
  const r = MessagePart.toolResponse("ls", false, undefined, "boom")
  if (r.type !== "tool_response") throw new Error("unreachable")
  check("tool_response data.error preserved", r.data.error === "boom")
  check("tool_response data.success=false", r.data.success === false)
}

/// ── renderContext joins parts ──

{
  const tmpl = responseTemplateFromConfig()
  const parts: MP[] = [MessagePart.user("hi"), MessagePart.text("hello")]
  const s = renderContext(parts, tmpl)
  check("renderContext non-empty", s.length > 0)
  check("renderContext contains the user prefix", s.startsWith(tmpl.user_message.start))
  check("renderContext contains the text body", s.includes("hello"))
}

/// ── Done ──

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) { console.log(failures.join("\n")); process.exit(1) }
