import express from "express"
import * as http from "http"
import * as path from "path"
import { fileURLToPath } from "url"
import { WebSocketServer, WebSocket } from "ws"
import { SessionHost } from "../session/session-host.ts"
import { createRpcHandler } from "../rpc/server.ts"

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

    const rpcHandler = createRpcHandler(this.host._model, this.host)
    this.app.use("/rpc{/*path}", async (req, res, next) => {
      const { matched } = await rpcHandler.handle(req as any, res as any, { prefix: "/rpc", context: {} })
      if (!matched) next()
    })

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
