import { createRequire } from "node:module"
import { DEFAULT_GEN_OPTS, type GenerateCallbacks, type Model, type MoSEHandle, type LoRAHandle, type MoseBlendWeights } from "../types.ts"
import type { MoSEEngine, LoRAManager } from "./mose.ts"

const _require = createRequire(import.meta.url)

interface RwSessionInstance {
  init(modelPath: string, vocabPath: string, quantLayers: number): Promise<void>
  tokenize(text: string): number[]
  detokenize(tokens: number[]): string
  infer(tokens: number[], maxTokens: number): Promise<string>
}

interface RwSessionConstructor {
  new (): RwSessionInstance
}

interface StateInfo {
  filePath: string
  fileSize: number
}

interface SystemPromptState {
  baselinePath: string
  fileSize: number
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

  mose!: MoSEHandle & MoSEEngine
  loraMgr!: LoRAHandle & LoRAManager

  constructor(modelPath: string, stateDir: string) {
    this.modelPath = modelPath
    this.stateDir = stateDir
  }

  async init(gpu?: string, loraPaths?: unknown): Promise<void> {
    const Ctor = loadBinding()
    this.binding = new Ctor()
    const vocabPath = this.resolveVocabPath()
    if (!this.binding) throw new Error("Failed to create native session")
    await this.binding.init(this.modelPath, vocabPath, 32)
  }

  private resolveVocabPath(): string {
    const idx = this.modelPath.lastIndexOf("/")
    return `${this.modelPath.slice(0, idx)}/rwkv_vocab_v20230424.json`
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

  async bakeSystemPrompt(systemPrompt: string): Promise<SystemPromptState> {
    this.systemPrompt = systemPrompt
    return { baselinePath: this.baselinePath(), fileSize: 0 }
  }

  async loadBaseline(): Promise<void> {
  }

  async saveCheckpoint(name: string): Promise<StateInfo> {
    return { filePath: this.statePath(name), fileSize: 0 }
  }

  async loadCheckpoint(name: string): Promise<void> {
  }

  getStateSize(): number {
    return 0
  }

  async evaluate(text: string): Promise<void> {
    const tokens = this.ensure().tokenize(text)
    if (tokens.length === 0) return
    await this.ensure().infer(tokens, 0)
  }

  async generate(
    prompt: string,
    opts: Record<string, unknown> = {}
  ): Promise<string> {
    let result = ""
    await this.generateStream(prompt, { onText: (t) => { result += t } }, opts)
    return result
  }

  async generateStream(
    prompt: string,
    callbacks: GenerateCallbacks = {},
    opts: Record<string, unknown> = {}
  ): Promise<string> {
    const model = this.ensure()

    const maxTokens = (opts.maxTokens as number) ?? DEFAULT_GEN_OPTS.maxTokens
    const stopSequences = (opts.stopSequences as string[]) ?? []

    const fullPrompt = this.systemPrompt
      ? `${this.systemPrompt}\n\n${prompt}`
      : prompt

    const tokens = model.tokenize(fullPrompt)
    const result = await model.infer(tokens, maxTokens)
    let text = result

    if (stopSequences.length > 0) {
      for (const seq of stopSequences) {
        const idx = text.indexOf(seq)
        if (idx !== -1) {
          text = text.slice(0, idx + seq.length)
          break
        }
      }
    }

    callbacks.onText?.(text)
    callbacks.onDone?.()
    return text
  }

  async generateWithBlend(
    prompt: string,
    blend?: MoseBlendWeights,
    opts: Record<string, unknown> = {}
  ): Promise<string> {
    return this.generate(prompt, opts)
  }

  async generateWithSegments(
    segments: { text: string; blend: MoseBlendWeights }[],
    opts: Record<string, unknown> = {}
  ): Promise<string> {
    const last = segments.pop()
    if (!last) return ""
    return this.generate(last.text, opts)
  }

  async dispose(): Promise<void> {
    this.binding = null
  }
}
