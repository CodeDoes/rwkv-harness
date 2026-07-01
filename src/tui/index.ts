import * as readline from "readline"
import * as path from "path"
import { RwkvModel } from "../model/rwkv-model.ts"
import type { Model } from "../types.ts"
import { SessionHost } from "../session/session-host.ts"
import { GatewayServer } from "../gateway/server.ts"
import { DEFAULT_GEN_OPTS } from "../types.ts"

const PROJECT_ROOT = path.resolve(import.meta.dirname!, "../..")

interface TuiOptions {
  modelPath: string
  stateDir: string
  story: string
  gpu: "vulkan" | "cuda" | "auto"
  loraPaths?: string[]
  fixParagraphs?: boolean
  agentDepth?: number
  grammar?: string
  gatewayPort?: number
  mode?: "direct" | "gateway_client"
  gatewayHost?: string
}

export class Tui {
  private options: TuiOptions
  private rl: readline.Interface

  constructor(options: TuiOptions) {
    this.options = options
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
    })
  }

  async start() {
    if (this.options.mode === "direct" || !this.options.mode) {
      await this.startDirect()
    } else {
      await this.startGatewayClient()
    }
  }

  private async startDirect() {
    console.error("\x1b[36mRWKV TUI (direct)\x1b[0m")

    const model = new RwkvModel(this.options.modelPath, this.options.stateDir)
    console.error("Loading model...")
    await model.init(this.options.gpu, this.options.loraPaths)
    console.error("Model loaded.")

    const agent = new SessionHost(model, this.options.stateDir)
    await agent.init()

    let generating = false
    console.error("Type /help for commands. /exit to quit.")
    console.error("---")

    this.rl.on("line", async (line) => {
      const input = line.trim()
      if (!input) { this.prompt(); return }

      if (input.startsWith("/")) {
        await this.handleDirectCommand(input, agent)
        this.prompt()
        return
      }

      if (generating) { this.prompt(); return }
      generating = true

      try {
        process.stdout.write("\n")
        await agent.chat(input, {
          onToken: (t) => process.stdout.write(t),
        })
        process.stdout.write("\n\n")
      } catch (err: any) {
        console.error("\x1b[31mError:\x1b[0m", err.message)
      }

      generating = false
      this.prompt()
    })

    this.prompt()
  }

  private async handleDirectCommand(input: string, agent: SessionHost) {
    const parts = input.slice(1).split(/\s+/)
    const verb = parts[0]

    switch (verb) {
      case "sessions":
      case "ls": {
        const sessions = await agent.listSessions()
        const current = agent.getCurrentSession()
        console.error(`\x1b[36mSessions:\x1b[0m (current: \x1b[33m${current.label}\x1b[0m)`)
        for (const s of sessions) {
          const marker = s.label === current.label ? " *" : "  "
          console.error(`  ${marker} ${s.label} (\x1b[90m${s.messageCount} msgs\x1b[0m)`)
        }
        break
      }
      case "session":
      case "switch": {
        const label = parts[1]
        if (!label) { console.error("Usage: /switch <label>"); break }
        try {
          const session = await agent.switchSession(label)
          console.error(`\x1b[32mSwitched to:\x1b[0m ${session.label} (\x1b[90m${session.messageCount} msgs\x1b[0m)`)
        } catch (e: any) {
          console.error(`\x1b[31mError:\x1b[0m ${e.message}`)
        }
        break
      }
      case "create": {
        const label = parts[1] || `session_${Date.now()}`
        const session = await agent.createSession(label)
        console.error(`\x1b[32mCreated:\x1b[0m ${session.label}`)
        break
      }
      case "delete": {
        const label = parts[1]
        if (!label) { console.error("Usage: /delete <label>"); break }
        try {
          await agent.deleteSession(label)
          console.error(`\x1b[32mDeleted:\x1b[0m ${label}`)
        } catch (e: any) {
          console.error(`\x1b[31mError:\x1b[0m ${e.message}`)
        }
        break
      }
      case "clear":
        console.clear()
        break
      case "help":
        console.error(`
\x1b[36mCommands:\x1b[0m
  /sessions, /ls     List sessions
  /switch <label>    Switch session
  /create <label>    Create new session
  /delete <label>    Delete session
  /clear             Clear screen
  /exit, /quit       Exit
`)
        break
      case "exit":
      case "quit":
        await agent.dispose()
        process.exit(0)
      default:
        console.error("Unknown:", verb, "(\x1b[90m/help\x1b[0m)")
    }
  }

  private async startGatewayClient() {
    const host = this.options.gatewayHost || "http://localhost:" + (this.options.gatewayPort || 3030)
    console.error(`\x1b[36mRWKV TUI (gateway client)\x1b[0m -> ${host}`)

    try {
      const r = await fetch(`${host}/sessions`)
      const data = await r.json()
      console.error(`Connected. Current session: \x1b[33m${data.current}\x1b[0m`)
      console.error("Type /help for commands.")
      console.error("---")
    } catch (err: any) {
      console.error("\x1b[31mCould not connect to gateway:\x1b[0m", err.message)
      return
    }

    this.rl.on("line", async (line) => {
      const input = line.trim()
      if (!input) { this.prompt(); return }

      if (input.startsWith("/")) {
        await this.handleClientCommand(input, host)
        this.prompt()
        return
      }

      try {
        process.stdout.write("\n")
        const r = await fetch(`${host}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: input }),
        })
        const data = await r.json()
        console.log(data.result)
        process.stdout.write("\n")
      } catch (err: any) {
        console.error("\x1b[31mError:\x1b[0m", err.message)
      }

      this.prompt()
    })

    this.prompt()
  }

  private async handleClientCommand(input: string, host: string) {
    const parts = input.slice(1).split(/\s+/)
    const verb = parts[0]

    switch (verb) {
      case "sessions":
      case "ls": {
        const r = await fetch(`${host}/sessions`)
        const data = await r.json()
        console.error(`\x1b[36mSessions:\x1b[0m (current: \x1b[33m${data.current}\x1b[0m)`)
        for (const s of data.sessions) {
          const marker = s.label === data.current ? " *" : "  "
          console.error(`  ${marker} ${s.label} (\x1b[90m${s.messageCount} msgs\x1b[0m)`)
        }
        break
      }
      case "create": {
        const label = parts[1] || `session_${Date.now()}`
        const r = await fetch(`${host}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        })
        const data = await r.json()
        console.error(`\x1b[32mCreated:\x1b[0m ${data.session?.label}`)
        break
      }
      case "switch": {
        const label = parts[1]
        if (!label) { console.error("Usage: /switch <label>"); break }
        const r = await fetch(`${host}/sessions/${label}/switch`, { method: "POST" })
        const data = await r.json()
        console.error(`\x1b[32mSwitched:\x1b[0m ${data.session?.label} (\x1b[90m${data.session?.messageCount} msgs\x1b[0m)`)
        break
      }
      case "help":
        console.error(`
Commands:
  /ls               List sessions
  /create <label>   New session
  /switch <label>   Switch session
  /exit             Exit
`)
        break
      case "exit":
      case "quit":
        process.exit(0)
    }
  }

  private prompt() {
    this.rl.setPrompt("\x1b[36m>\x1b[0m ")
    this.rl.prompt()
  }
}
