import { createRequire } from "node:module"
import {
  DEFAULT_GEN_OPTS,
  type Model,
  type MoSEHandle,
  type LoRAHandle,
  type ProcessOpts,
  type GenerateRequest,
  type GenerateResult,
  type StreamGenerateRequest,
} from "../types.ts"
import { MoSEEngine, LoRAManager } from "./mose.ts"

const GENERATE_TIMEOUT = 120_000

const _require = createRequire(import.meta.url)

interface RwSessionInstance {
  init(modelPath: string, vocabPath?: string, quantLayers?: number): Promise<void>
  tokenize(text: string): number[]
  detokenize(tokens: number[]): string
  infer(tokens: number[], maxTokens?: number, temperature?: number, topP?: number): Promise<string>
  inferStream(tokens: number[], onToken: (token: string) => void, maxTokens?: number, temperature?: number, topP?: number): Promise<string>
  getStateSize(): number
  saveState(path: string): Promise<void>
  loadState(path: string): Promise<void>
  evaluate(text: string): Promise<void>
  setGrammar(grammar: string): void
  clearGrammar(): void
}

interface RwSessionConstructor {
  new (): RwSessionInstance
}

interface StateInfo {
  filePath: string
  fileSize: number
}

interface LiveSession {
  id: string
  aborted: boolean
  ancestor?: string
}

let _cachedBinding: RwSessionConstructor | null = null

function loadBinding(): RwSessionConstructor {
  if (_cachedBinding) return _cachedBinding
  try {
    const mod = _require("../../native/rwkv-bindings/rwkv-bindings.linux-x64-gnu.node") as { RwSession: unknown }
    _cachedBinding = mod.RwSession as RwSessionConstructor
    return _cachedBinding
  } catch {
    throw new Error("Native RWKV binding not found. Build: cd native/rwkv-bindings && cargo build --release")
  }
}

export class NativeRwkvModel implements Model {
  private binding: RwSessionInstance | null = null
  private modelPath: string
  private stateDir: string
  private systemPrompt: string = ""
  private baselinePrologue: string = ""
  private live: Map<string, LiveSession> = new Map()
  private sessionSeq = 0

  mose!: MoSEHandle & MoSEEngine
  loraMgr!: LoRAHandle & LoRAManager

  constructor(modelPath: string, stateDir: string) {
    this.modelPath = modelPath
    this.stateDir = stateDir
    this.mose = new MoSEEngine(this as Model, stateDir)
    this.loraMgr = new LoRAManager(this as Model)
  }

  async init(gpu?: string, loraPaths?: unknown): Promise<void> {
    const Ctor = loadBinding()
    this.binding = new Ctor()
    if (!this.binding) throw new Error("Failed to create native session")
    await this.binding.init(this.modelPath, undefined, 32)
  }

  private ensure(): RwSessionInstance {
    if (!this.binding) throw new Error("Model not initialized")
    return this.binding
  }

  tokenize(text: string): number[] {
    return this.ensure().tokenize(text)
  }

  detokenize(tokens: number[]): string {
    return this.ensure().detokenize(tokens)
  }

  statePath(name: string): string {
    return `${this.stateDir}/_state_${name}.state`
  }

  private baselinePath(): string {
    return `${this.stateDir}/_system_baseline.state`
  }

  async bakeSystemPrompt(systemPrompt: string): Promise<{ baselinePath: string; fileSize: number }> {
    this.systemPrompt = systemPrompt
    const binding = this.ensure()
    const path = this.baselinePath()
    await binding.saveState(path)
    const stat = await import("node:fs/promises").then(f => f.stat(path))
    this.baselinePrologue = systemPrompt
    return { baselinePath: path, fileSize: stat.size }
  }

  async loadBaseline(): Promise<void> {
    const path = this.baselinePath()
    const binding = this.ensure()
    try {
      await binding.loadState(path)
    } catch {
    }
  }

  async saveCheckpoint(name: string): Promise<StateInfo> {
    const binding = this.ensure()
    const path = this.statePath(name)
    await binding.saveState(path)
    const stat = await import("node:fs/promises").then(f => f.stat(path))
    return { filePath: path, fileSize: stat.size }
  }

  async loadCheckpoint(name: string): Promise<void> {
    const binding = this.ensure()
    await binding.loadState(this.statePath(name))
  }

  getStateSize(): number {
    return this.ensure().getStateSize()
  }

  async evaluate(text: string): Promise<void> {
    await this.ensure().evaluate(text)
  }

  async process(opts: ProcessOpts = {}): Promise<{ sessionId: string }> {
    this.sessionSeq++
    const sid = `${Date.now().toString(36)}-${this.sessionSeq.toString(36)}`
    const live: LiveSession = { id: sid, aborted: false, ancestor: opts.stateCheckpoint }
    this.live.set(sid, live)
    if (opts.stateCheckpoint) {
      try {
        await this.loadCheckpoint(opts.stateCheckpoint)
        await this.ensure().evaluate(opts.append?.content ?? "")
      } catch {
      }
    } else {
      await this.loadBaseline()
      if (opts.append) {
        await this.ensure().evaluate(opts.append.content)
      }
    }
    return { sessionId: sid }
  }

  async interrupt(sessionId: string): Promise<{ stopReason: "Interrupted" }> {
    const live = this.live.get(sessionId)
    if (live) live.aborted = true
    return { stopReason: "Interrupted" }
  }

  private filterByStopSequences(text: string, stopSequences: string[]): { text: string; stopped: boolean } {
    if (stopSequences.length === 0) return { text, stopped: false }
    let earliest = -1
    let earliestSeq = ""
    for (const seq of stopSequences) {
      const idx = text.indexOf(seq)
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx
        earliestSeq = seq
      }
    }
    if (earliest !== -1) {
      return { text: text.slice(0, earliest + earliestSeq.length), stopped: true }
    }
    return { text, stopped: false }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.streamGenerate({ ...req, onToken: undefined })
  }

  async streamGenerate(req: StreamGenerateRequest): Promise<GenerateResult> {
    const binding = this.ensure()
    const live = this.live.get(req.sessionId)
    if (live?.aborted) {
      return { sessionId: req.sessionId, text: "", stopReason: "interrupt" }
    }

    const opts = req.opts ?? {}
    const maxTokens = opts.maxTokens ?? DEFAULT_GEN_OPTS.maxTokens
    const temperature = opts.temperature ?? DEFAULT_GEN_OPTS.temperature
    const topP = opts.topP ?? DEFAULT_GEN_OPTS.topP
    const stopSequences = (opts as Record<string, unknown>).stopSequences as string[] | undefined ?? []

    binding.clearGrammar()
    const grammar = opts.grammar as string | undefined
    if (grammar) binding.setGrammar(grammar)

    const tokens = binding.tokenize(req.prompt)

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`generate timed out after ${GENERATE_TIMEOUT}ms`)), GENERATE_TIMEOUT)
    )

    const abortCheck = async () => {
      while (!live?.aborted && !req.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error("generation interrupted")
    }

    let raw = ""
    try {
      if (req.onToken) {
        const result = await Promise.race([
          binding.inferStream(tokens, (token: string) => {
            raw += token
            req.onToken!(token)
          }, maxTokens, temperature, topP),
          abortCheck(),
          timeout,
        ]) as string
        if (result && result.length > raw.length) raw = result
      } else {
        const result = await Promise.race([
          binding.infer(tokens, maxTokens, temperature, topP),
          abortCheck(),
          timeout,
        ]) as string
        raw = result
      }
    } catch (err) {
      const liveAborted = live?.aborted || req.signal?.aborted
      if (liveAborted) {
        return { sessionId: req.sessionId, text: raw, stopReason: "interrupt" }
      }
      throw err
    }

    const { text, stopped } = this.filterByStopSequences(raw, stopSequences)
    return { sessionId: req.sessionId, text, stopReason: stopped ? "stop" : "length" }
  }

  async dispose(): Promise<void> {
    this.binding = null
    this.live.clear()
  }
}
