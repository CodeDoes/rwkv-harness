import express from "express"
import * as http from "http"
import * as path from "path"
import { fileURLToPath } from "url"
import { WebSocketServer, WebSocket } from "ws"
import { SessionHost } from "../session/session-host.ts"
import type { GenerateOpts } from "../types.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, "../..")

let channelIdCounter = 0

export class GatewayServer {
  private host: SessionHost
  private app: express.Express
  private server: http.Server
  private wss: WebSocketServer
  private channels: Map<number, WebSocket> = new Map()
  private ready: Promise<void>
  private resolveReady!: () => void

  constructor(host: SessionHost, webappDir?: string) {
    this.host = host
    this.ready = new Promise((resolve) => { this.resolveReady = resolve })

    this.app = express()
    this.app.use(express.json())

    // Block non-health requests until model is ready
    this.app.use((_req, res, next) => {
      if (_req.path === "/health") { next(); return }
      this.ready.then(() => next()).catch(() => next())
    })

    const staticDir = webappDir || path.join(PROJECT_ROOT, "webapp")
    this.app.use(express.static(staticDir))

    this.server = http.createServer(this.app)
    this.wss = new WebSocketServer({ server: this.server })

    this.setupRoutes()
    this.setupWebSocket()
  }

  /** Mark model as ready — queued requests will now proceed. */
  markReady() {
    this.resolveReady()
  }

  private setupRoutes() {
    this.app.get("/health", (_req, res) => {
      res.json({ status: "ok", channels: this.channels.size })
    })

    this.app.get("/sessions", async (_req, res) => {
      try {
        const sessions = await this.host.listSessions()
        const current = this.host.getCurrentSession()
        res.json({ sessions, current: current.label })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.post("/sessions", async (req, res) => {
      try {
        const { label } = req.body
        if (!label) { res.status(400).json({ error: "label required" }); return }
        const session = await this.host.createSession(label)
        const messages = this.host.getMessages()
        this.broadcast({ type: "session_created", session, messages })
        res.json({ session, messages })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.post("/sessions/:label/switch", async (req, res) => {
      try {
        const session = await this.host.switchSession(req.params.label)
        const messages = this.host.getMessages()
        this.broadcast({ type: "session_switched", session, messages })
        res.json({ session, messages })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.delete("/sessions/:label", async (req, res) => {
      try {
        await this.host.deleteSession(req.params.label)
        const current = this.host.getCurrentSession()
        const messages = this.host.getMessages()
        this.broadcast({ type: "session_deleted", label: req.params.label, current, messages })
        res.json({ deleted: req.params.label, current, messages })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.get("/sessions/:label/messages", (req, res) => {
      const messages = this.host.getMessages(req.params.label)
      res.json({ messages })
    })

    this.app.post("/chat", async (req, res) => {
      try {
        const { prompt } = req.body
        if (!prompt) { res.status(400).json({ error: "prompt required" }); return }

        let fullResult = ""
        const result = await this.host.chat(prompt, {
          onToken: (t) => { fullResult += t },
        })
        res.json({ result })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    // ---- HttpModel protocol endpoints ----

    this.app.post("/process", async (req, res) => {
      try {
        await this.ready
        const { modelPath: _mp, systemPrompt, append, stateCheckpoint } = req.body
        const { sessionId } = await this.host._model.process({ systemPrompt, append, stateCheckpoint })
        res.json({ sessionId })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.post("/generate", async (req, res) => {
      try {
        await this.ready
        const { sessionId, prompt, opts } = req.body
        const result = await this.host._model.generate({ sessionId, prompt, opts: opts as Partial<GenerateOpts> })
        res.json(result)
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.post("/interrupt", async (req, res) => {
      try {
        await this.ready
        const { sessionId } = req.body
        const result = await this.host._model.interrupt(sessionId)
        res.json(result)
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    // ---- v1-compat endpoints (HttpModel protocol) ----

    this.app.post("/v1/generate", async (req, res) => {
      try {
        const { prompt, ...genOpts } = req.body
        if (!prompt) { res.status(400).json({ error: "prompt required" }); return }
        const { sessionId } = await this.host._model.process()
        const result = await this.host._model.generate({ sessionId, prompt, opts: genOpts as Partial<GenerateOpts> })
        await this.host._model.interrupt(sessionId)
        res.json({ text: result.text })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.post("/v1/stream", async (req, res) => {
      try {
        const { prompt, ...genOpts } = req.body
        if (!prompt) { res.status(400).json({ error: "prompt required" }); return }

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })

        const { sessionId } = await this.host._model.process()
        let fullResult = ""
        const result = await this.host._model.streamGenerate({
          sessionId,
          prompt,
          opts: genOpts as Partial<GenerateOpts>,
          onToken: (t) => {
            fullResult += t
            res.write(`data: ${JSON.stringify({ type: "token", text: t })}\n\n`)
          },
        })
        res.write(`data: ${JSON.stringify({ type: "done", sessionId, stopReason: result.stopReason, text: fullResult })}\n\n`)
        res.end()
      } catch (err: any) {
        res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`)
        res.end()
      }
    })

    this.app.post("/v1/evaluate", async (req, res) => {
      try {
        const { text } = req.body
        if (!text) { res.status(400).json({ error: "text required" }); return }
        await this.host._model.evaluate(text)
        res.json({ status: "ok" })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.post("/v1/state/save", async (req, res) => {
      try {
        const { slotName } = req.body
        if (!slotName) { res.status(400).json({ error: "slotName required" }); return }
        const result = await this.host._model.saveCheckpoint(slotName)
        res.json({ path: result.filePath, size: result.fileSize })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    this.app.post("/v1/state/load", async (req, res) => {
      try {
        const { slotName } = req.body
        if (!slotName) { res.status(400).json({ error: "slotName required" }); return }
        await this.host._model.loadCheckpoint(slotName)
        res.json({ status: "ok" })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    // ---- MoSE endpoints ----

    const mose = () => this.host._model.mose
    const loraMgr = () => this.host._model.loraMgr

    /** POST /mose/experts — create a new expert state from text. */
    this.app.post("/mose/experts", async (req, res) => {
      try {
        const { name, text, weight } = req.body
        if (!name || !text) { res.status(400).json({ error: "name and text required" }); return }
        const expert = await mose().createExpert(name, text, weight ?? 1.0)
        res.json({ expert })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    /** GET /mose/experts — list registered experts. */
    this.app.get("/mose/experts", (_req, res) => {
      res.json({ experts: mose().list() })
    })

    /** DELETE /mose/experts/:name — remove an expert. */
    this.app.delete("/mose/experts/:name", async (req, res) => {
      try {
        const ok = await mose().removeExpert(req.params.name)
        res.json({ removed: ok })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    /** POST /mose/blend — set blend weights and load blended state. */
    this.app.post("/mose/blend", async (req, res) => {
      try {
        const { weights } = req.body
        if (!weights) { res.status(400).json({ error: "weights required" }); return }
        await mose().apply(weights)
        res.json({ status: "blended", weights })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    /** POST /mose/generate — blend then generate. */
    this.app.post("/mose/generate", async (req, res) => {
      try {
        const { prompt, blend, ...genOpts } = req.body
        if (!prompt) { res.status(400).json({ error: "prompt required" }); return }
        await mose().apply(blend)
        const { sessionId } = await this.host._model.process()
        const result = await this.host._model.generate({ sessionId, prompt, opts: genOpts as Partial<GenerateOpts>, blend })
        await this.host._model.interrupt(sessionId)
        res.json({ result: result.text })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    /** POST /mose/segment — segment routing. */
    this.app.post("/mose/segment", async (req, res) => {
      try {
        const { segments } = req.body
        if (!segments || !Array.isArray(segments) || segments.length === 0) {
          res.status(400).json({ error: "segments array required" }); return
        }
        const last = segments[segments.length - 1]
        const { sessionId } = await this.host._model.process()
        const result = await this.host._model.generate({
          sessionId,
          prompt: last.text,
          opts: {},
          segments,
        })
        await this.host._model.interrupt(sessionId)
        res.json({ result: result.text })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    // ---- MoLE endpoints ----

    /** POST /lora/experts — register a LoRA adapter. */
    this.app.post("/lora/experts", async (req, res) => {
      try {
        const { name, filePath, scale } = req.body
        if (!name || !filePath) { res.status(400).json({ error: "name and filePath required" }); return }
        loraMgr().add(name, filePath, scale ?? 1.0)
        res.json({ status: "registered", name })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    /** GET /lora/experts — list registered LoRA adapters. */
    this.app.get("/lora/experts", (_req, res) => {
      res.json({ adapters: loraMgr().list(), active: loraMgr().getActive() })
    })

    /** DELETE /lora/experts/:name — remove a registered LoRA adapter. */
    this.app.delete("/lora/experts/:name", (req, res) => {
      loraMgr().remove(req.params.name)
      res.json({ removed: true })
    })

    /** POST /lora/activate — activate one or more LoRA adapters. */
    this.app.post("/lora/activate", async (req, res) => {
      try {
        const { adapters } = req.body
        if (!adapters || !Array.isArray(adapters)) {
          res.status(400).json({ error: "adapters array required" }); return
        }
        await loraMgr().activate(...adapters)
        res.json({ status: "activated", adapters })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

    /** POST /lora/deactivate — deactivate all LoRA adapters. */
    this.app.post("/lora/deactivate", async (_req, res) => {
      try {
        await loraMgr().deactivateAll()
        res.json({ status: "all deactivated" })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })
  }

  private setupWebSocket() {
    this.wss.on("connection", (ws: WebSocket) => {
      const channelId = ++channelIdCounter
      this.channels.set(channelId, ws)
      console.error(`[gateway] channel ${channelId} connected (${this.channels.size} total)`)

      ws.send(JSON.stringify({
        type: "connected",
        channelId,
        session: this.host.getCurrentSession(),
        messages: this.host.getMessages(),
        sessions: Array.from((this.host as any).sessions.keys()),
      }))

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString())

          switch (msg.type) {
            case "chat": {
              const { prompt } = msg
              if (!prompt) {
                ws.send(JSON.stringify({ type: "error", message: "prompt required" }))
                return
              }
              this.broadcast({ type: "user_message", content: prompt, channelId })

              await this.host.chat(prompt, {
                onToken: (t) => {
                  this.broadcast({ type: "token", text: t, channelId })
                },
              })

              this.broadcast({
                type: "done",
                session: this.host.getCurrentSession(),
                messages: this.host.getMessages(),
              })
              break
            }

            case "create_session": {
              const session = await this.host.createSession(msg.label)
              const messages = this.host.getMessages()
              this.broadcast({ type: "session_created", session, messages })
              break
            }

            case "switch_session": {
              const session = await this.host.switchSession(msg.label)
              const messages = this.host.getMessages()
              this.broadcast({ type: "session_switched", session, messages })
              break
            }

            case "delete_session": {
              await this.host.deleteSession(msg.label)
              const current = this.host.getCurrentSession()
              const messages = this.host.getMessages()
              this.broadcast({ type: "session_deleted", label: msg.label, current, messages })
              break
            }

            default:
              ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }))
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", message: err.message }))
        }
      })

      ws.on("close", () => {
        this.channels.delete(channelId)
        console.error(`[gateway] channel ${channelId} disconnected (${this.channels.size} total)`)
      })

      ws.on("error", () => {
        this.channels.delete(channelId)
      })
    })
  }

  private broadcast(data: object) {
    const payload = JSON.stringify(data)
    for (const [id, ws] of this.channels) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
      } else {
        this.channels.delete(id)
      }
    }
  }

  async start(port = 3030, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        resolve()
      })
    })
  }

  getHttpServer(): http.Server {
    return this.server
  }

  async stop(): Promise<void> {
    this.wss.close()
    for (const [_, ws] of this.channels) {
      ws.close()
    }
    this.channels.clear()
    await this.host.dispose()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}
