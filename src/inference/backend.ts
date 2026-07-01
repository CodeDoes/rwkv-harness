import * as fsp from "fs/promises"
import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { getLlama, LlamaModel, LlamaContext, LlamaContextSequence, LlamaGrammar, LlamaGrammarEvaluationState } from "node-llama-cpp"
import { GenerateOpts, DEFAULT_GEN_OPTS } from "../core/types.ts"

export interface StreamCallbacks {
  onToken?: (text: string) => void
  onDone?: (meta: { tokens: number; text: string; truncated?: boolean; stateSlot?: string }) => void
  onError?: (err: string) => void
}

export interface BackendConfig {
  maxConcurrency?: number
  idleTimeoutMs?: number
  hardMaxTokens?: number
}

function stateHash(modelPath: string, loraPaths: string[], slotName: string): string {
  const key = `${modelPath}|${loraPaths.join(",")}|${slotName}`
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)
}

export class InferenceBackend {
  private llama: Awaited<ReturnType<typeof getLlama>> | null = null
  private slotsDir: string

  private _model: LlamaModel | null = null
  private _modelPath: string = ""
  private _loras: string[] = []
  private _loadedModelPath: string = ""

  private _sequence: LlamaContextSequence | null = null
  private _context: LlamaContext | null = null

  // --- controllability ---
  private activeRequests = 0
  private maxConcurrency: number
  private hardMaxTokens: number
  private idleTimeoutMs: number
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private lastActivity: number = Date.now()
  private disposed = false

  constructor(slotsDir: string, config: BackendConfig = {}) {
    this.slotsDir = slotsDir
    this.maxConcurrency = config.maxConcurrency ?? 4
    this.idleTimeoutMs = config.idleTimeoutMs ?? 5 * 60 * 1000
    this.hardMaxTokens = config.hardMaxTokens ?? 4096
  }

  private async ensureLlama(): Promise<Awaited<ReturnType<typeof getLlama>>> {
    if (!this.llama) {
      this.llama = await getLlama({ gpu: "vulkan" })
    }
    return this.llama
  }

  private tmp(suffix: string): string {
    return path.join(this.slotsDir, `_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`)
  }

  /** Try to acquire a concurrency slot. Returns false if at capacity. */
  tryAcquire(): boolean {
    if (this.activeRequests >= this.maxConcurrency) return false
    this.activeRequests++
    this.touch()
    return true
  }

  /** Release a concurrency slot. */
  release(): void {
    if (this.activeRequests > 0) this.activeRequests--
    this.touch()
  }

  /** Current concurrency info. */
  concurrencyInfo(): { active: number; max: number } {
    return { active: this.activeRequests, max: this.maxConcurrency }
  }

  /** Reset idle timer on any activity. */
  private touch(): void {
    this.lastActivity = Date.now()
    this.resetIdleTimer()
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(() => this.unloadIfIdle(), this.idleTimeoutMs)
  }

  private async unloadIfIdle(): Promise<void> {
    const elapsed = Date.now() - this.lastActivity
    if (elapsed < this.idleTimeoutMs) return
    if (this.activeRequests > 0) {
      this.resetIdleTimer()
      return
    }
    await this.unloadModel()
  }

  /** Unload model+context+sequence. Keeps llama instance alive. */
  private async unloadModel(): Promise<void> {
    if (!this._model) return
    try { this._sequence?.dispose() } catch { /* */ }
    try { this._context?.dispose() } catch { /* */ }
    try { this._model?.dispose() } catch { /* */ }
    this._sequence = null
    this._context = null
    this._model = null
    this._modelPath = ""
    this._loras = []
    this._loadedModelPath = ""
  }

  /** Check if model is currently loaded. */
  isLoaded(): boolean {
    return this._model !== null && this._context !== null && this._sequence !== null
  }

  async ensureModel(modelPath: string, loraPaths: string[]): Promise<void> {
    this.touch()
    const loras = loraPaths ?? []

    const modelChanged = this._loadedModelPath !== modelPath
    const lorasChanged = JSON.stringify(this._loras) !== JSON.stringify(loras)

    if (!this._model || modelChanged) {
      if (this._context) { try { this._context.dispose() } catch { /* */ } this._context = null }
      if (this._sequence) { try { this._sequence.dispose() } catch { /* */ } this._sequence = null }
      if (this._model) { try { this._model.dispose() } catch { /* */ } }
      const llama = await this.ensureLlama()
      this._model = await llama.loadModel({ modelPath })
      this._loadedModelPath = modelPath
      this._loras = []
    }

    if (lorasChanged || !this._context) {
      if (this._context) { try { this._context.dispose() } catch { /* */ } }
      if (this._sequence) { try { this._sequence.dispose() } catch { /* */ } }
      const loraOpts = loras.length > 0 ? { lora: loras.map((p) => ({ filePath: p, scale: 1.0 })) as any } : {}
      this._context = await this._model!.createContext({ contextSize: 8192, ...loraOpts })
      this._sequence = this._context.getSequence()
      this._loras = loras
    }
  }

  /** Reset the sequence (clear context). */
  async resetSequence(): Promise<void> {
    if (!this._context || !this._model) return
    try { this._sequence?.dispose() } catch { /* */ }
    this._sequence = this._context.getSequence()
  }

  async loadStateSlot(slotName: string, modelPath: string, loraPaths: string[]): Promise<void> {
    await this.ensureModel(modelPath, loraPaths)
    const slotPath = this.statePath(modelPath, loraPaths, slotName)
    if (fs.existsSync(slotPath)) {
      await this._sequence!.loadStateFromFile(slotPath, { acceptRisk: true })
    }
  }

  statePath(modelPath: string, loraPaths: string[], slotName: string): string {
    const h = stateHash(modelPath, loraPaths, slotName)
    return path.join(this.slotsDir, `${h}.state`)
  }

  async saveStateSlot(slotName: string, modelPath: string, loraPaths: string[]): Promise<{ path: string; size: number }> {
    if (!this._sequence) throw new Error("No active sequence — call ensureModel first")
    const slotPath = this.statePath(modelPath, loraPaths, slotName)
    const { fileSize } = await this._sequence.saveStateToFile(slotPath)
    return { path: slotPath, size: fileSize }
  }

  async generate(prompt: string, opts: Partial<GenerateOpts> = {}): Promise<{ text: string; truncated: boolean; stateSlot?: string }> {
    let out = ""
    let truncated = false
    let stateSlot: string | undefined
    await this.stream(prompt, {
      onToken: (t) => { out += t },
      onDone: (meta) => { truncated = meta.truncated ?? false; stateSlot = meta.stateSlot },
    }, opts)
    return { text: out, truncated, stateSlot }
  }

  async stream(prompt: string, cbs: StreamCallbacks, opts: Partial<GenerateOpts> = {}): Promise<void> {
    this.touch()
    if (!this._sequence || !this._model) throw new Error("Model not loaded — call ensureModel first")
    const genOpts = { ...DEFAULT_GEN_OPTS, ...opts }
    const tokens = this._model.tokenize(prompt)
    let grammarEvalState: LlamaGrammarEvaluationState | undefined
    if (genOpts.grammar) {
      const llama = await this.ensureLlama()
      const grammar = await llama.createGrammar({ grammar: genOpts.grammar })
      grammarEvalState = new LlamaGrammarEvaluationState({ model: this._model, grammar })
    }
    const stopSeqs: string[] = (opts as any).stopSequences ?? []
    const effectiveMax = Math.min(genOpts.maxTokens, this.hardMaxTokens)
    const gen = this._sequence.evaluate(tokens, {
      maxTokens: effectiveMax,
      temperature: genOpts.temperature,
      topP: genOpts.topP,
      repeatPenalty: {
        punishTokens: [] as number[],
        penalty: genOpts.repeatPenalty,
        frequencyPenalty: genOpts.frequencyPenalty,
        presencePenalty: genOpts.presencePenalty,
      },
      grammarEvaluationState: grammarEvalState as any,
      yieldEogToken: true,
    } as any)
    let result = ""
    let count = 0
    let truncated = false
    try {
      for await (const token of gen) {
        if (this._model.isEogToken(token)) break
        const text = this._model.detokenize([token])
        result += text
        count++
        cbs.onToken?.(text)
        if (stopSeqs.some((seq) => result.includes(seq))) break
      }
      // If we hit the exact token count (no EOS), it was truncated
      if (count >= effectiveMax) {
        truncated = true
      }
      let stateSlot: string | undefined
      if (truncated && this._sequence) {
        const resumeName = `_resume_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
        const slotPath = path.join(this.slotsDir, `${resumeName}.state`)
        await this._sequence.saveStateToFile(slotPath)
        stateSlot = resumeName
      }
      cbs.onDone?.({ tokens: count, text: result, truncated, stateSlot })
    } catch (err: any) {
      cbs.onError?.(err.message ?? String(err))
    }
  }

  async evaluate(text: string): Promise<{ tokens: number }> {
    this.touch()
    if (!this._sequence || !this._model) throw new Error("Model not loaded")
    const tokens = this._model.tokenize(text)
    await this._sequence.evaluateWithoutGeneratingNewTokens(tokens)
    return { tokens: tokens.length }
  }

  tokenize(text: string): number[] {
    if (!this._model) throw new Error("Model not loaded")
    return this._model.tokenize(text)
  }

  get activeRequestCount(): number {
    return this.activeRequests
  }

  /** Dispose all resources. Stops idle timer. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    await this.unloadModel()
    this.llama = null
  }
}