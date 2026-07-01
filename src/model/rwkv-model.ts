import { getLlama, LlamaModel, LlamaContext, LlamaContextSequence, LlamaGrammar, LlamaGrammarEvaluationState } from "node-llama-cpp"
import { GenerateOpts, DEFAULT_GEN_OPTS, GenerateCallbacks, type Model, type MoSEHandle, type LoRAHandle } from "../types.ts"
import type { MoseBlendWeights } from "../types.ts"
import { MoSEEngine, LoRAManager } from "./mose.ts"
import type { Token } from "node-llama-cpp"

interface StateInfo {
  filePath: string
  fileSize: number
}

interface SystemPromptState {
  baselinePath: string
  fileSize: number
}

interface RwkvModelCtx {
  llama: Awaited<ReturnType<typeof getLlama>>
  model: LlamaModel
  context: LlamaContext
  sequence: LlamaContextSequence
}

interface LoraOpts {
  adapters: { filePath: string; scale?: number }[]
}

type GenOptsWithExtras = Partial<GenerateOpts> & { fixParagraphBreak?: boolean; stopSequences?: string[] }

export class RwkvModel implements Model {
  private ctx: RwkvModelCtx | null = null
  private modelPath: string
  private stateDir: string
  private systemState: SystemPromptState | null = null
  private loras: LoraOpts | null = null
  /** MoSE — Mixture of State Experts. Created after init(). */
  mose!: MoSEHandle & MoSEEngine
  /** LoRA expert manager. Created after init(). */
  loraMgr!: LoRAHandle & LoRAManager

  constructor(modelPath: string, stateDir: string) {
    this.modelPath = modelPath
    this.stateDir = stateDir
  }

  get loraAdapters(): { filePath: string; scale?: number }[] {
    return this.loras?.adapters ?? []
  }

  get moseExperts(): string[] {
    return this.mose?.list?.().map(e => e.name) ?? []
  }

  /** Initialize MoSE + LoRA managers (safe to call after init resolves). */
  private initMoSE() {
    this.mose = new MoSEEngine(this, this.stateDir)
    this.loraMgr = new LoRAManager(this)
  }

  async init(gpu: "vulkan" | "cuda" | "auto" = "vulkan", loraPaths?: string | string[]) {
    const llama = await getLlama({ gpu })
    const model = await llama.loadModel({ modelPath: this.modelPath })

    if (loraPaths) {
      const paths = Array.isArray(loraPaths) ? loraPaths : [loraPaths]
      this.loras = {
        adapters: paths.map((p) => ({ filePath: p, scale: 1.0 })),
      }
    }

    const context = await model.createContext({
      contextSize: 8192,
      ...(this.loras ? { lora: this.loras } as any : {}),
    })
    const sequence = context.getSequence()
    this.ctx = { llama, model, context, sequence }
    this.initMoSE()
  }

  async setLora(loraPaths: string | string[]) {
    if (!this.ctx) throw new Error("Engine not initialized")
    const paths = Array.isArray(loraPaths) ? loraPaths : [loraPaths]
    this.loras = {
      adapters: paths.map((p) => ({ filePath: p, scale: 1.0 })),
    }
    const ctx = this.ctx.context as any
    if (ctx._setLoras) {
      const model = this.ctx.model as any
      const addonLoras = await Promise.all(
        this.loras.adapters.map(async (a) => model._getOrLoadLora(a.filePath))
      )
      await ctx._setLoras(
        this.loras.adapters.map((a, i) => ({
          lora: addonLoras[i],
          scale: a.scale ?? 1.0,
        }))
      )
    }
  }

  private ensureCtx(): RwkvModelCtx {
    if (!this.ctx) throw new Error("Model not initialized. Call init() first.")
    return this.ctx
  }

  statePath(name: string): string {
    return `${this.stateDir}/_state_${name}.state`
  }

  get model(): LlamaModel {
    return this.ensureCtx().model
  }

  get sequence(): LlamaContextSequence {
    return this.ensureCtx().sequence
  }

  tokenize(text: string): Token[] {
    return this.model.tokenize(text)
  }

  detokenize(tokens: Token[]): string {
    return this.model.detokenize(tokens)
  }

  private baselinePath(): string {
    return `${this.stateDir}/_system_baseline.state`
  }

  async bakeSystemPrompt(systemPrompt: string): Promise<SystemPromptState> {
    const { sequence } = this.ensureCtx()
    const tokens = this.model.tokenize(systemPrompt)
    await sequence.evaluateWithoutGeneratingNewTokens(tokens)
    const { fileSize } = await sequence.saveStateToFile(this.baselinePath())
    this.systemState = { baselinePath: this.baselinePath(), fileSize }
    await sequence.loadStateFromFile(this.baselinePath(), { acceptRisk: true })
    return this.systemState
  }

  async loadBaseline() {
    const { sequence } = this.ensureCtx()
    await sequence.loadStateFromFile(this.baselinePath(), { acceptRisk: true })
  }

  async saveCheckpoint(name: string): Promise<StateInfo> {
    const { sequence } = this.ensureCtx()
    const path = this.statePath(name)
    const { fileSize } = await sequence.saveStateToFile(path)
    return { filePath: path, fileSize }
  }

  async loadCheckpoint(name: string) {
    const { sequence } = this.ensureCtx()
    await sequence.loadStateFromFile(this.statePath(name), { acceptRisk: true })
  }

  private toEvalOpts(opts: Partial<GenerateOpts> = {}) {
    const o = { ...DEFAULT_GEN_OPTS, ...opts }
    return {
      maxTokens: o.maxTokens,
      temperature: o.temperature,
      topP: o.topP,
      repeatPenalty: {
        punishTokens: [] as Token[],
        penalty: o.repeatPenalty,
        frequencyPenalty: o.frequencyPenalty,
        presencePenalty: o.presencePenalty,
      },
    }
  }

  async generate(
    prompt: string,
    opts: GenOptsWithExtras = {}
  ): Promise<string> {
    let result = ""
    await this.generateStream(prompt, { onText: (t) => { result += t } }, opts)
    return result
  }

  async generateStream(
    prompt: string,
    callbacks: GenerateCallbacks = {},
    opts: GenOptsWithExtras = {}
  ): Promise<string> {
    const ctx = this.ensureCtx()
    const { sequence, model, llama } = ctx
    const genOpts = this.toEvalOpts(opts)

    const tokens = model.tokenize(prompt)

    let grammarEvalState: LlamaGrammarEvaluationState | undefined
    if (opts.grammar) {
      const grammar = await llama.createGrammar({ grammar: opts.grammar })
      grammarEvalState = new LlamaGrammarEvaluationState({ model, grammar })
    }

    const gen = sequence.evaluate(tokens, {
      ...genOpts,
      grammarEvaluationState: grammarEvalState,
      yieldEogToken: true,
    })

    let result = ""
    let eogToken: Token | null = null

    for await (const token of gen) {
      if (model.isEogToken(token)) {
        eogToken = token
        break
      }
      const text = model.detokenize([token])
      result += text
      callbacks.onText?.(text)

      if (opts.stopSequences) {
        let stopped = false
        for (const seq of opts.stopSequences) {
          const idx = result.indexOf(seq)
          if (idx !== -1) {
            result = result.slice(0, idx + seq.length)
            stopped = true
            break
          }
        }
        if (stopped) break
      }
    }

    if (
      opts.fixParagraphBreak &&
      eogToken != null &&
      result.trimEnd().length > 0
    ) {
      const trimmed = result.trimEnd()
      const trailingNewlines = result.length - trimmed.length
      if (trailingNewlines >= 2) {
        const remaining = (opts.maxTokens ?? DEFAULT_GEN_OPTS.maxTokens) - result.length
        if (remaining > 0) {
          const spaceTokens = model.tokenize("\n")
          const contGen = sequence.evaluate(spaceTokens, {
            ...genOpts as any,
            grammarEvaluationState: grammarEvalState,
            yieldEogToken: true,
            maxTokens: remaining,
          })
          let cont = ""
          for await (const t of contGen) {
            if (model.isEogToken(t)) break
            const text = model.detokenize([t])
            cont += text
            callbacks.onText?.(text)
          }
          if (cont.trim().length > 0) {
            result += "\n" + cont
          }
        }
      }
    }

    callbacks.onDone?.()
    return result
  }

  async evaluate(text: string) {
    const tokens = this.model.tokenize(text)
    await this.sequence.evaluateWithoutGeneratingNewTokens(tokens)
  }

  getStateSize(): number {
    return this.ensureCtx().context.stateSize
  }

  /**
   * Generate with MoSE state blending.
   * Blends expert states → loads into sequence → generates.
   */
  async generateWithBlend(
    prompt: string,
    blend?: MoseBlendWeights,
    opts: GenOptsWithExtras = {}
  ): Promise<string> {
    await this.mose.apply(blend)
    return this.generate(prompt, opts)
  }

  /**
   * Generate with MoSE segment routing.
   * Each segment uses a different state blend before evaluation.
   */
  async generateWithSegments(
    segments: { text: string; blend: MoseBlendWeights }[],
    opts: GenOptsWithExtras = {}
  ): Promise<string> {
    // Last segment's text is treated as the prompt for generation
    const last = segments.pop()!
    for (const seg of segments) {
      await this.mose.segmentRoute([seg])
    }
    // Blend and generate for final segment
    await this.mose.apply(last.blend)
    return this.generate(last.text, opts)
  }

  async dispose() {
    if (this.ctx) {
      this.ctx.sequence.dispose()
      this.ctx.context.dispose()
      this.ctx.model.dispose()
      this.ctx = null
    }
  }
}
