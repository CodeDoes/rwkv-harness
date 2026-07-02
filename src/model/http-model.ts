import type { Model, MoseBlendWeights, MoSEHandle, LoRAHandle, MoSEExpert, ProcessOpts, GenerateRequest, GenerateResult, StreamGenerateRequest } from "../types.ts"
import { spawn } from "child_process"

function trimSlash(s: string): string {
  return s.replace(/\/$/, "")
}

async function jsonReq<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export class HttpModel implements Model {
  private readonly url: string
  private _modelPath: string = ""
  private _loraPaths: string[] = []
  private _currentSlot: string = "default"

  constructor(url: string) {
    this.url = trimSlash(url)
  }

  async init(_gpu?: string, _loraPaths?: unknown): Promise<void> { /* stateless — no init needed */ }

  async dispose(): Promise<void> { /* nothing to dispose */ }

  tokenize(_text: string): number[] { return [] }
  detokenize(_tokens: number[]): string { return "" }

  private async ensureModel(modelPath: string, loraPaths?: string[]) {
    this._modelPath = modelPath
    this._loraPaths = loraPaths ?? []
  }

  private stateSlotName(name: string): string { return name }

  async process(opts: ProcessOpts = {}): Promise<{ sessionId: string }> {
    const r = await jsonReq<{ sessionId: string }>(`${this.url}/process`, {
      method: "POST",
      body: JSON.stringify({ modelPath: this._modelPath, ...opts }),
    })
    return r
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const r = await jsonReq<GenerateResult>(`${this.url}/generate`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: req.sessionId,
        prompt: req.prompt,
        opts: req.opts,
        blend: req.blend,
        segments: req.segments,
      }),
    })
    return r
  }

  async streamGenerate(req: StreamGenerateRequest): Promise<GenerateResult> {
    const res = await fetch(`${this.url}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: req.sessionId,
        prompt: req.prompt,
        opts: req.opts,
        blend: req.blend,
        segments: req.segments,
      }),
    })
    if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    let out = ""
    let lastResult: GenerateResult | null = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const events = buf.split("\n\n")
      buf = events.pop() ?? ""
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data:"))
        if (!line) continue
        const data = line.slice(5).trim()
        try {
          const msg = JSON.parse(data) as { type: string; text?: string; sessionId?: string; stopReason?: GenerateResult["stopReason"] }
          if (msg.type === "token" && msg.text) {
            out += msg.text
            req.onToken?.(msg.text)
          } else if (msg.type === "done" && msg.sessionId) {
            lastResult = { sessionId: msg.sessionId, text: out, stopReason: msg.stopReason ?? "stop" }
          } else if (msg.type === "error") {
            throw new Error((msg as unknown as { error: string }).error ?? "stream error")
          }
        } catch (e) {
          if (e instanceof Error && e.message !== "stream error") continue
          throw e
        }
      }
    }
    return lastResult ?? { sessionId: req.sessionId, text: out, stopReason: "stop" }
  }

  async interrupt(sessionId: string): Promise<{ stopReason: "Interrupted" }> {
    const r = await jsonReq<{ stopReason: "Interrupted" }>(`${this.url}/interrupt`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    })
    return r
  }

  async evaluate(text: string): Promise<void> {
    await jsonReq(`${this.url}/v1/evaluate`, {
      method: "POST",
      body: JSON.stringify({ modelPath: this._modelPath, loraPaths: this._loraPaths, text }),
    })
  }

  async saveCheckpoint(name: string): Promise<{ filePath: string; fileSize: number }> {
    const r = await jsonReq<{ path: string; size: number }>(`${this.url}/v1/state/save`, {
      method: "POST",
      body: JSON.stringify({ modelPath: this._modelPath, loraPaths: this._loraPaths, slotName: this.stateSlotName(name) }),
    })
    return { filePath: r.path, fileSize: r.size }
  }

  async loadCheckpoint(name: string): Promise<void> {
    this._currentSlot = this.stateSlotName(name)
    await jsonReq(`${this.url}/v1/state/load`, {
      method: "POST",
      body: JSON.stringify({ modelPath: this._modelPath, loraPaths: this._loraPaths, slotName: this.stateSlotName(name) }),
    })
  }

  statePath(_name: string): string { return "" }

  async bakeSystemPrompt(systemPrompt: string): Promise<{ baselinePath: string; fileSize: number }> {
    await this.evaluate(systemPrompt)
    const saved = await this.saveCheckpoint("system_baseline")
    return { baselinePath: saved.filePath, fileSize: saved.fileSize }
  }

  async loadBaseline(): Promise<void> {
    await this.loadCheckpoint("system_baseline")
  }

  getStateSize(): number { return 0 }

  get mose(): MoSEHandle {
    return {
      async createExpert(_name: string, _text: string, _weight = 1.0): Promise<MoSEExpert> {
        return { name: _name, stateFile: "", weight: _weight }
      },
      list: () => [],
      get: () => undefined,
      async removeExpert() { return false },
      setWeight: () => false,
      setWeights: () => { /* */ },
      async apply(_weights?: MoseBlendWeights) { /* stateless — state managed per generate */ },
      async segmentRoute(_segments: { text: string; blend: MoseBlendWeights }[]) { void _segments },
      async dispose() { /* */ },
    }
  }

  get loraMgr(): LoRAHandle {
    return {
      add(_name, _filePath, _scale = 1.0) { /* no-op, paths passed per-call */ },
      remove(_name) { return false },
      list: () => [],
      getActive: () => [...this._loraPaths],
      async activate(..._names: string[]) { void _names },
      async deactivateAll() { /* */ },
    }
  }

  get modelPath(): string { return this._modelPath }
  get loraAdapters(): { filePath: string; scale?: number }[] {
    return this._loraPaths.map((p) => ({ filePath: p, scale: 1.0 }))
  }
  get moseExperts(): string[] { return [] }
}

export interface BootOpts {
  modelPath: string
  gpu?: string
  loraPaths?: string[]
  port?: number
  maxConcurrency?: number
  hardMaxTokens?: number
  idleTimeoutMs?: number
}

export async function bootRemoteModel(opts: BootOpts): Promise<{ model: HttpModel; close: () => Promise<void> }> {
  const port = opts.port ?? parseInt(process.env.INFERENCE_PORT ?? "3210", 10)
  const url = `http://127.0.0.1:${port}`
  const healthUrl = `${url}/health`

  let alive = false
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
    alive = r.ok
  } catch { /* down */ }

  if (!alive) {
    const args = [
      "tsx", "inference-server.ts",
      `--port=${port}`,
      `--slots-dir=inference-slots/${port}`,
      `--max-concurrency=${opts.maxConcurrency ?? 4}`,
      `--max-tokens=${opts.hardMaxTokens ?? 4096}`,
      `--idle-timeout=${opts.idleTimeoutMs ?? 300000}`,
    ]
    const child = spawn("pnpm", args, { detached: true, stdio: "ignore", cwd: process.cwd() })
    child.unref()
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
        if (r.ok) { alive = true; break }
      } catch { /* retry */ }
      await new Promise((res) => setTimeout(res, 500))
    }
    if (!alive) throw new Error(`Inference server did not come up at ${url} within 180s`)
  }

  const model = new HttpModel(url)
  await model.init()

  model["_modelPath"] = opts.modelPath
  model["_loraPaths"] = opts.loraPaths ?? []

  return { model, close: async () => { await model.dispose() } }
}
