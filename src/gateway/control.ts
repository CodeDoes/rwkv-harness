import { NativeRwkvModel } from "../model/native-rwkv-model.ts"
import { SessionHost } from "../session/session-host.ts"
import { GatewayServer } from "./server.ts"
import { HttpModel } from "../model/http-model.ts"
import { fileURLToPath } from "url"
import { dirname, resolve, join } from "path"
import { promises as fsp } from "fs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, "../..")
const SESSIONS_DIR = "sessions"

export interface GatewayControlOpts {
  modelPath: string
  port?: number
  gpu?: "vulkan" | "cuda" | "auto"
  loraPaths?: string[]
  webDir?: string
}

/**
 * GatewayControl — client-side lifecycle manager for the gateway.
 *
 * Phase 6: the client never loads the model directly. GatewayControl ensures
 * the gateway is running (in-process for local dev) and returns an HttpModel
 * that talks to it over oRPC.
 */
export class GatewayControl {
  private opts: Required<GatewayControlOpts>
  private model: NativeRwkvModel | null = null
  private host: SessionHost | null = null
  private server: GatewayServer | null = null
  private _running = false

  constructor(opts: GatewayControlOpts) {
    this.opts = {
      modelPath: opts.modelPath,
      port: opts.port ?? 3030,
      gpu: opts.gpu ?? "vulkan",
      loraPaths: opts.loraPaths ?? [],
      webDir: opts.webDir ?? resolve(PROJECT_ROOT, "src", "web"),
    }
  }

  get running(): boolean { return this._running }
  get url(): string { return `http://127.0.0.1:${this.opts.port}` }

  async start(): Promise<void> {
    if (this._running) return

    const stateDir = join(SESSIONS_DIR, "_gateway")
    const model = new NativeRwkvModel(this.opts.modelPath, stateDir)
    this.model = model

    const host = new SessionHost(model, stateDir)
    this.host = host

    const server = new GatewayServer(host, this.opts.webDir, this.opts.modelPath)
    this.server = server

    await server.start(this.opts.port)
    await model.init(this.opts.gpu, this.opts.loraPaths)
    await host.init()
    server.markReady()
    this._running = true
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    if (this.server) {
      await this.server.stop().catch(() => {})
      this.server = null
    }
    if (this.host) {
      await this.host.dispose().catch(() => {})
      this.host = null
    }
    if (this.model) {
      await this.model.dispose().catch(() => {})
      this.model = null
    }
  }

  /** Returns an HttpModel connected to the running gateway. */
  connect(): HttpModel {
    return new HttpModel(this.url)
  }

  /** Ensure gateway is running, then connect. */
  async ensure(): Promise<HttpModel> {
    await this.start()
    return this.connect()
  }

  /** Check gateway health without starting it. */
  async isHealthy(): Promise<boolean> {
    try {
      const r = await fetch(`${this.url}/rpc/health`, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch {
      return false
    }
  }
}

/** Default singleton for CLI use. */
let defaultControl: GatewayControl | null = null

export function getDefaultControl(opts?: GatewayControlOpts): GatewayControl {
  if (!defaultControl) {
    if (!opts) throw new Error("GatewayControl not initialized — provide opts on first call")
    defaultControl = new GatewayControl(opts)
  }
  return defaultControl
}
