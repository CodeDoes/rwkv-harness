import { promises as fsp } from "fs"
import * as path from "path"
import crypto from "crypto"
import { RwkvSession, RwkvMessage } from "../types.ts"
import type { Session } from "./session.ts"
import { MessagePart } from "../protocol/message-part.ts"

const SESSIONS_DIR = "sessions"

type JsonlLine =
  | { type: "init"; id: string; slug: string; model: string; createdAt: string }
  | { type: "message"; role: RwkvMessage["role"]; content: string; step: number; timestamp: string }
  | { type: "checkpoint"; name: string; path: string; step: number }
  | { type: "baseline"; path: string }

export class SessionManager {
  private sessionDir: string
  private sessionFile: string
  private session: RwkvSession
  private sessionId: string

  constructor(storyDir: string, story: string, model: string) {
    const ts = Date.now().toString(36)
    const id = crypto.randomBytes(4).toString("hex")
    const slug = story
    this.sessionId = `${ts}_${id}_${slug}`
    this.sessionDir = path.join(SESSIONS_DIR, this.sessionId)
    this.sessionFile = path.join(this.sessionDir, "session.jsonl")
    this.session = {
      story,
      model,
      messages: [],
      stepCount: 0,
      status: "new",
      statePaths: {
        baseline: path.join(this.sessionDir, "_system_baseline.state"),
        checkpoints: {},
        latest: null,
      },
    }
  }

  async load(): Promise<RwkvSession> {
    try {
      const raw = await fsp.readFile(this.sessionFile, "utf-8")
      const lines = raw.trim().split("\n").filter(Boolean)
      const messages: RwkvMessage[] = []
      const statePaths = {
        baseline: path.join(this.sessionDir, "_system_baseline.state"),
        checkpoints: {} as Record<string, string>,
        latest: null as string | null,
      }

      for (const line of lines) {
        const entry: JsonlLine = JSON.parse(line)
        switch (entry.type) {
          case "init":
            this.session.story = entry.slug
            this.session.model = entry.model
            this.session.status = "active"
            break
          case "message":
            messages.push({ role: entry.role, content: entry.content })
            break
          case "checkpoint":
            statePaths.checkpoints[entry.name] = entry.path
            statePaths.latest = entry.path
            break
          case "baseline":
            statePaths.baseline = entry.path
            break
        }
      }

      this.session.messages = messages
      this.session.statePaths = statePaths
      this.session.stepCount = messages.filter((m) => m.role === "assistant").length
      return this.session
    } catch {
      return this.session
    }
  }

  async save(): Promise<void> {
    this.session.updatedAt = new Date().toISOString()
    this.session.stepCount = this.session.messages.filter((m) => m.role === "assistant").length
    await fsp.mkdir(this.sessionDir, { recursive: true })

    const lines: string[] = []
    const initLine: JsonlLine = {
      type: "init",
      id: this.sessionId,
      slug: this.session.story,
      model: this.session.model,
      createdAt: this.session.updatedAt,
    }
    lines.push(JSON.stringify(initLine))

    let step = 0
    for (const m of this.session.messages) {
      step++
      const msgLine: JsonlLine = {
        type: "message",
        role: m.role,
        content: m.content,
        step,
        timestamp: new Date().toISOString(),
      }
      lines.push(JSON.stringify(msgLine))
    }

    for (const [name, filePath] of Object.entries(this.session.statePaths.checkpoints)) {
      const cpLine: JsonlLine = {
        type: "checkpoint",
        name,
        path: filePath,
        step: this.session.stepCount,
      }
      lines.push(JSON.stringify(cpLine))
    }

    const blLine: JsonlLine = {
      type: "baseline",
      path: this.session.statePaths.baseline,
    }
    lines.push(JSON.stringify(blLine))

    await fsp.writeFile(this.sessionFile, lines.join("\n") + "\n", "utf-8")
  }

  get sessionDirPath(): string {
    return this.sessionDir
  }

  get sessionIdStr(): string {
    return this.sessionId
  }

  get(): RwkvSession {
    return this.session
  }

  addMessage(msg: RwkvMessage) {
    this.session.messages.push(msg)
  }

  buildPrompt(systemPrompt: string, useRoles = false): string {
    const msgs = this.session.messages
    let prompt = systemPrompt.replace(/[ \t]+(\n|$)/g, "$1") + "\n\n"
    for (const m of msgs) {
      switch (m.role) {
        case "user":
          prompt += `${useRoles ? "User: " : ""}${m.content.replace(/[ \t]+(\n|$)/g, "$1")}\n\n`
          break
        case "assistant":
          prompt += `${useRoles ? "Assistant: " : ""}${m.content.replace(/[ \t]+(\n|$)/g, "$1")}\n\n`
          break
        case "tool":
          prompt += `[Tool result: ${m.content.slice(0, 200)}]\n\n`
          break
      }
    }
    return prompt
  }

  registerCheckpoint(name: string, filePath: string) {
    this.session.statePaths.checkpoints[name] = filePath
    this.session.statePaths.latest = filePath
  }

  getLatestCheckpoint(): string | null {
    return this.session.statePaths.latest
      ? path.resolve(this.session.statePaths.latest)
      : null
  }

  async ensureDir() {
    await fsp.mkdir(this.sessionDir, { recursive: true })
  }

  stateFilePath(name: string): string {
    return path.join(this.sessionDir, `_state_${name}.state`)
  }

  async saveLog(text: string) {
    await fsp.appendFile(path.join(this.sessionDir, "_agent.log"), text, "utf-8")
  }

  /** Bridge: save a Session's context into this manager's JSONL. */
  async saveFromSession(session: Session): Promise<void> {
    this.session.messages = session.context.map((p) => {
      if (p.type === "user_message") return { role: "user" as const, content: p.content }
      if (p.type === "text")          return { role: "assistant" as const, content: p.content }
      if (p.type === "tool_response") {
        const info = p.data.success
          ? `result: ${JSON.stringify(p.data.data ?? {})}`
          : `error: ${p.data.error ?? "unknown"}`
        return { role: "tool" as const, content: info.slice(0, 200) }
      }
      if (p.type === "tool_call") return { role: "assistant" as const, content: `<tool_call>${JSON.stringify(p.data)}</tool_call>` }
      return { role: "assistant" as const, content: "" }
    })
    await this.save()
  }

  /** Bridge: restore a Session's context from this manager's JSONL. */
  async restoreToSession(session: Session): Promise<void> {
    await this.load()
    for (const m of this.session.messages) {
      if (m.role === "user") {
        session.context.push(MessagePart.user(m.content))
      } else if (m.role === "assistant") {
        const tcMatch = m.content.match(/<tool_call>(.*?)<\/tool_call>/)
        if (tcMatch) {
          try {
            const parsed = JSON.parse(tcMatch[1])
            session.context.push(MessagePart.toolCall(parsed.name ?? "unknown", parsed.arguments ?? {}))
          } catch {
            session.context.push(MessagePart.text(m.content))
          }
        } else {
          session.context.push(MessagePart.text(m.content))
        }
      } else if (m.role === "tool") {
        session.context.push(MessagePart.toolResponse("system", m.content.startsWith("result:")))
      }
    }
  }
}
