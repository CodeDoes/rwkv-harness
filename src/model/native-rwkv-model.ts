import { createRequire } from "node:module"
import {
  DEFAULT_GEN_OPTS,
  type Engine,
  type MoSEHandle,
  type LoRAHandle,
  type ProcessOpts,
  type GenerateRequest,
  type GenerateResult,
  type StreamGenerateRequest,
} from "../types.ts"
import { MoSEEngine, LoRAManager } from "./mose.ts"
import { StateTuneCache } from "../core/state-tune-cache.ts"

const GENERATE_TIMEOUT = 120_000

const _require = createRequire(import.meta.url)

interface RwSessionInstance {
  init(modelPath: string, vocabPath?: string, quantLayers?: number): Promise<void>
  tokenize(text: string): number[]
  detokenize(tokens: number[]): string
  infer(tokens: number[], maxTokens?: number, temperature?: number, topP?: number, stopTokens?: string[]): Promise<string>
  inferStream(tokens: number[], onToken: (token: string) => void, maxTokens?: number, temperature?: number, topP?: number, stopTokens?: string[]): Promise<string>
  getStateSize(): number
  saveState(path: string): Promise<void>
  loadState(path: string): Promise<void>
  evaluate(text: string): Promise<void>
  setGrammar(grammar: string): void
  clearGrammar(): void
  grammarCheck(gbnf: string, text: string): {
    ok: boolean
    firstFail: number
    acceptedTokens: number
    remainingTokens: number
  }
  /** Read model file into host RAM (no VRAM). */
  prepareRam(modelPath: string): Promise<void>
  /** Re-upload from RAM and rebuild runtime. */
  bindGpu(quantLayers?: number): Promise<void>
  /** Drop runtime, free VRAM; bytes remain in RAM. */
  unbindGpu(): void
  /** True when runtime currently allocated. */
  isGpuBound(): boolean
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

export class NativeRwkvModel implements Engine {
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
    this.mose = new MoSEEngine(this as Engine, stateDir)
    this.loraMgr = new LoRAManager(this as Engine)
  }

  async init(gpu?: string, loraPaths?: unknown): Promise<void> {
    const Ctor = loadBinding()
    this.binding = new Ctor()
    if (!this.binding) throw new Error("Failed to create native session")
    await this.binding.init(this.modelPath, undefined, 32)
  }

  /**
   * Drop the GPU bundle (VRAM). The safetensors bytes remain in
   * host RAM (cached during init). The model is `isGpuBound() ===
   * false`; future calls to `inferStream`/`infer` will trigger a
   * `bindGpu()` first.
   */
  async unbindFromGpu(): Promise<void> {
    this.ensure().unbindGpu()
  }

  /** VRAM-resident? */
  isGpuBound(): boolean {
    return this.ensure().isGpuBound()
  }

  /**
   * Re-promote the cached safetensors bytes back to VRAM and rebuild
   * the runtime. The next generation will use the new VRAM context.
   * Caller is responsible for any state-restore via `loadCheckpoint`
   * — state is dropped alongside the runtime when unbound.
   */
  async bindToGpu(): Promise<void> {
    this.ensure().bindGpu(32)
  }

  private async ensureGpu(): Promise<void> {
    if (!this.isGpuBound()) await this.bindToGpu()
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

  /**
   * Tokenize `text` via the real RWKV tokenizer and walk a fresh
   * `GrammarState` over the tokens. Returns whether the run finishes
   * in a valid state — i.e. the same contract `infer` enforces with
   * the model logit mask, *without* sampling, so we can validate
   * any candidate output independently of the live session.
   */
  async grammarCheck(gbnf: string, text: string): Promise<{
    ok: boolean
    firstFail: number
    acceptedTokens: number
    remainingTokens: number
  }> {
    return this.ensure().grammarCheck(gbnf, text)
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
    await this.ensureGpu()
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
        // When resuming from a checkpoint, state has moved away from the
        // canonical baseline; force re-evaluation so we don't get stuck
        // against a stale hash.
        await this.ensure().evaluate(opts.append?.content ?? "")
      } catch {
      }
    } else {
      await this.loadBaseline()
      const appendText = opts.append?.content ?? ""
      if (appendText) {
        if (this.canSkipStateTuneBaking(appendText)) {
          // Cached: same content already baked through this binding since
          // the last reset. We just loaded baseline → state already
          // contains the equivalent RNN activation.
        } else {
          await this.ensure().evaluate(appendText)
          this.recordStateTuneBaked(appendText)
        }
      }
    }
    return { sessionId: sid }
  }

  /**
   * Optional content-hash cache. If a `stateTuneCache` is provided,
   * `process()` will skip re-running `evaluate(appendText)` when the
   * exact same content has already been baked against a fresh baseline.
   *
   * Default is `null` → no caching, current behavior preserved.
   */
  private stateTuneCache: StateTuneCache | null = null
  private lastStateTuneHash: string | null = null

  /** Wire (or clear) a state-tune cache. Pass `null` to disable. */
  setStateTuneCache(cache: StateTuneCache | null): void {
    this.stateTuneCache = cache
    // When the cache is swapped, the binding state is presumed unchanged
    // but the bookkeeping rolls over: any pending "we just baked this hash"
    // has to be re-established so we don't bypass the next baking either.
    this.lastStateTuneHash = null
  }

  private canSkipStateTuneBaking(text: string): boolean {
    if (!this.stateTuneCache) return false
    const hash = StateTuneCache.hash(undefined, text)
    return this.stateTuneCache.has(hash) && hash === this.lastStateTuneHash
  }

  private recordStateTuneBaked(text: string): void {
    if (!this.stateTuneCache) return
    const hash = StateTuneCache.hash(undefined, text)
    this.stateTuneCache.set(hash, { bytes: Buffer.byteLength(text, "utf-8") })
    this.lastStateTuneHash = hash
  }

  async interrupt(sessionId: string): Promise<{ stopReason: "Interrupted" }> {
    const live = this.live.get(sessionId)
    if (live) live.aborted = true
    return { stopReason: "Interrupted" }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.streamGenerate({ ...req, onToken: undefined })
  }

  async streamGenerate(req: StreamGenerateRequest): Promise<GenerateResult> {
    await this.ensureGpu()
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

    const bindingStopTokens = stopSequences.length > 0 ? stopSequences : undefined

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
          }, maxTokens, temperature, topP, bindingStopTokens),
          abortCheck(),
          timeout,
        ]) as string
        if (result && result.length > raw.length) raw = result
      } else {
        const result = await Promise.race([
          binding.infer(tokens, maxTokens, temperature, topP, bindingStopTokens),
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

    const stopSeqFound = stopSequences.some(s => raw.endsWith(s))
    return { sessionId: req.sessionId, text: raw, stopReason: stopSeqFound ? "stop" : "length" }
  }

  async dispose(): Promise<void> {
    this.binding = null
    this.live.clear()
  }
}
