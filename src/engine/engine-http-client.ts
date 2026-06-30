import type { Engine, GenerateCallbacks, MoseBlendWeights, MoSEHandle, LoRAHandle, MoSEExpert } from "../core/types.ts"
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

export class EngineHTTPClient implements Engine {
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

  async generate(prompt: string, opts?: Record<string, unknown>): Promise<string> {
    const r = await jsonReq<{ text: string }>(`${this.url}/v1/generate`, {
      method: "POST",
      body: JSON.stringify({
        modelPath: this._modelPath,
        loraPaths: this._loraPaths,
        stateSlot: this._currentSlot,
        prompt,
        ...opts,
      }),
    })
    return r.text
  }

  async generateStream(prompt: string, callbacks?: GenerateCallbacks, opts?: Record<string, unknown>): Promise<string> {
    console.error(`[HTTP-CLIENT] POST ${this.url}/v1/stream, prompt len: ${prompt.length}, opts: ${JSON.stringify(opts).slice(0, 200)}`)
    const res = await fetch(`${this.url}/v1/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelPath: this._modelPath,
        loraPaths: this._loraPaths,
        stateSlot: this._currentSlot,
        prompt,
        ...opts,
      }),
    })
    console.error(`[HTTP-CLIENT] response status: ${res.status}, has body: ${!!res.body}`)
    if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    let out = ""
    let eventCount = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = dec.decode(value, { stream: true })
      console.error(`[HTTP-CLIENT] received chunk: ${chunk.length} chars`)
      buf += chunk
      const events = buf.split("\n\n")
      buf = events.pop() ?? ""
      for (const ev of events) {
        eventCount++
        const line = ev.split("\n").find((l) => l.startsWith("data:"))
        if (!line) continue
        const data = line.slice(5).trim()
        console.error(`[HTTP-CLIENT] event ${eventCount}: ${data.slice(0, 100)}`)
        try {
          const msg = JSON.parse(data) as { type: string; text?: string; error?: string }
          if (msg.type === "token" && msg.text) {
            out += msg.text
            callbacks?.onText?.(msg.text)
          } else if (msg.type === "done") {
            callbacks?.onDone?.()
          } else if (msg.type === "error") {
            throw new Error(msg.error ?? "stream error")
          }
        } catch { /* skip */ }
      }
    }
    callbacks?.onDone?.()
    return out
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

  async generateWithBlend(prompt: string, blend?: MoseBlendWeights, opts?: Record<string, unknown>): Promise<string> {
    if (blend && Object.keys(blend).length > 0) {
      void blend
    }
    return this.generate(prompt, opts)
  }

  async generateWithSegments(_segments: { text: string; blend: MoseBlendWeights }[], opts?: Record<string, unknown>): Promise<string> {
    return this.generate(_segments[_segments.length - 1].text, opts)
  }

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
}

export async function bootEngine(opts: BootOpts): Promise<{ engine: EngineHTTPClient; close: () => Promise<void> }> {
  const port = opts.port ?? parseInt(process.env.INFERENCE_PORT ?? "3210", 10)
  const url = `http://127.0.0.1:${port}`
  const healthUrl = `${url}/health`

  let alive = false
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
    alive = r.ok
  } catch { /* down */ }

  if (!alive) {
    const child = spawn(
      "pnpm",
      ["tsx", "inference-server.ts", `--port=${port}`, `--slots-dir=inference-slots/${port}`],
      { detached: true, stdio: "ignore", cwd: process.cwd() },
    )
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

  const engine = new EngineHTTPClient(url)
  await engine.init()

  engine["_modelPath"] = opts.modelPath
  engine["_loraPaths"] = opts.loraPaths ?? []

  return { engine, close: async () => { await engine.dispose() } }
}