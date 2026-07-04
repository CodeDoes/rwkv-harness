import type { Engine, MoseBlendWeights, MoSEHandle, LoRAHandle, MoSEExpert, ProcessOpts, GenerateRequest, GenerateResult, StreamGenerateRequest } from "../types.ts"
import { spawn } from "child_process"
import { createRpcClient, type RpcClient } from "../rpc/client.ts"

function trimSlash(s: string): string {
  return s.replace(/\/$/, "")
}

export class HttpModel implements Engine {
  private readonly rpc: RpcClient
  private readonly rpcUrl: string
  private _modelPath: string = ""
  private _loraPaths: string[] = []
  private _currentSlot: string = "default"

  constructor(url: string) {
    this.rpcUrl = `${trimSlash(url)}/rpc`
    this.rpc = createRpcClient(this.rpcUrl)
  }

  async init(_gpu?: string, _loraPaths?: unknown): Promise<void> { /* stateless — no init needed */ }

  async dispose(): Promise<void> { /* nothing to dispose */ }

  async modelInfo(): Promise<{ model: string; stateSize: number }> {
    return this.rpc.modelInfo()
  }

  tokenize(_text: string): number[] { return [] }
  detokenize(_tokens: number[]): string { return "" }

  private async ensureModel(modelPath: string, loraPaths?: string[]) {
    this._modelPath = modelPath
    this._loraPaths = loraPaths ?? []
  }

  private stateSlotName(name: string): string { return name }

  async process(opts: ProcessOpts = {}): Promise<{ sessionId: string }> {
    return this.rpc.process(opts)
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.rpc.generate({
      sessionId: req.sessionId,
      prompt: req.prompt,
      opts: req.opts,
      blend: req.blend,
      segments: req.segments,
    })
  }

  async streamGenerate(req: StreamGenerateRequest): Promise<GenerateResult> {
    const iter = await this.rpc.stream({
      sessionId: req.sessionId,
      prompt: req.prompt,
      opts: req.opts,
      blend: req.blend,
      segments: req.segments,
    })
    let text = ""
    for await (const event of iter) {
      text += event.token
      req.onToken?.(event.token)
    }
    return { sessionId: req.sessionId, text, stopReason: "stop" }
  }

  async interrupt(sessionId: string): Promise<{ stopReason: "Interrupted" }> {
    return this.rpc.interrupt({ sessionId })
  }

  async evaluate(text: string): Promise<void> {
    await this.rpc.evaluate({ text })
  }

  async saveCheckpoint(name: string): Promise<{ filePath: string; fileSize: number }> {
    const r = await this.rpc.saveCheckpoint({ slotName: this.stateSlotName(name) })
    return { filePath: r.path, fileSize: r.size }
  }

  async loadCheckpoint(name: string): Promise<void> {
    this._currentSlot = this.stateSlotName(name)
    await this.rpc.loadCheckpoint({ slotName: this.stateSlotName(name) })
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
    const rpc = this.rpc
    return {
      async createExpert(name: string, text: string, weight = 1.0): Promise<MoSEExpert> {
        return rpc.mose.createExpert({ name, text, weight })
      },
      list: () => [],
      get: () => undefined,
      async removeExpert(name: string) {
        return rpc.mose.removeExpert({ name })
      },
      setWeight: () => false,
      setWeights: () => { /* */ },
      async apply(weights?: MoseBlendWeights) {
        await rpc.mose.apply({ weights })
      },
      async segmentRoute(segments: { text: string; blend: MoseBlendWeights }[]) {
        await rpc.mose.segmentRoute({ segments })
      },
      async dispose() { /* */ },
    }
  }

  get loraMgr(): LoRAHandle {
    const rpc = this.rpc
    const rpcLora = this.rpc.lora
    return {
      add(name, filePath, scale = 1.0) {
        rpcLora.add({ name, filePath, scale })
      },
      remove(name) {
        rpcLora.remove({ name })
        return true
      },
      list: () => [],
      getActive: () => [...this._loraPaths],
      async activate(...names: string[]) {
        await rpcLora.activate({ adapters: names })
      },
      async deactivateAll() {
        await rpcLora.deactivate(undefined)
      },
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
  const healthUrl = `${url}/rpc/health`

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
