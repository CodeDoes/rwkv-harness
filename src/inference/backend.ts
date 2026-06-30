import * as fsp from "fs/promises"
import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { getLlama, LlamaModel, LlamaContext, LlamaContextSequence, LlamaGrammar, LlamaGrammarEvaluationState } from "node-llama-cpp"
import { GenerateOpts, DEFAULT_GEN_OPTS } from "../core/types.ts"

export interface StreamCallbacks {
  onToken?: (text: string) => void
  onDone?: (meta: { tokens: number; text: string }) => void
  onError?: (err: string) => void
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

  private _sequence: LlamaContextSequence | null = null
  private _context: LlamaContext | null = null

  constructor(slotsDir: string) {
    this.slotsDir = slotsDir
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

  async ensureModel(modelPath: string, loraPaths: string[]): Promise<void> {
    const loras = loraPaths ?? []

    const modelChanged = this._modelPath !== modelPath
    const lorasChanged = JSON.stringify(this._loras) !== JSON.stringify(loras)

    if (!this._model || modelChanged) {
      if (this._context) { try { this._context.dispose() } catch { /* */ } this._context = null }
      if (this._sequence) { try { this._sequence.dispose() } catch { /* */ } this._sequence = null }
      if (this._model) { try { this._model.dispose() } catch { /* */ } }
      const llama = await this.ensureLlama()
      this._model = await llama.loadModel({ modelPath })
      this._modelPath = modelPath
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

  async generate(prompt: string, opts: Partial<GenerateOpts> = {}): Promise<string> {
    let out = ""
    await this.stream(prompt, { onToken: (t) => { out += t } }, opts)
    return out
  }

  async stream(prompt: string, cbs: StreamCallbacks, opts: Partial<GenerateOpts> = {}): Promise<void> {
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
    const gen = this._sequence.evaluate(tokens, {
      maxTokens: genOpts.maxTokens,
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
    try {
      for await (const token of gen) {
        if (this._model.isEogToken(token)) break
        const text = this._model.detokenize([token])
        result += text
        count++
        cbs.onToken?.(text)
        if (stopSeqs.some((seq) => result.includes(seq))) break
      }
      cbs.onDone?.({ tokens: count, text: result })
    } catch (err: any) {
      cbs.onError?.(err.message ?? String(err))
    }
  }

  async evaluate(text: string): Promise<{ tokens: number }> {
    if (!this._sequence || !this._model) throw new Error("Model not loaded")
    const tokens = this._model.tokenize(text)
    await this._sequence.evaluateWithoutGeneratingNewTokens(tokens)
    return { tokens: tokens.length }
  }

  tokenize(text: string): number[] {
    if (!this._model) throw new Error("Model not loaded")
    return this._model.tokenize(text)
  }
}