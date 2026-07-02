import { createRequire } from "node:module"
import { DEFAULT_GEN_OPTS, type GenerateCallbacks, type Model, type MoSEHandle, type LoRAHandle, type MoseBlendWeights } from "../types.ts"
import { MoSEEngine, LoRAManager } from "./mose.ts"

const _require = createRequire(import.meta.url)

interface RwSessionInstance {
  init(modelPath: string, vocabPath?: string, quantLayers?: number): Promise<void>
  tokenize(text: string): number[]
  detokenize(tokens: number[]): string
  infer(tokens: number[], maxTokens?: number, temperature?: number, topP?: number): Promise<string>
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
    const binding = this.ensure()

    await this.loadBaseline()

    const maxTokens = (opts.maxTokens as number) ?? DEFAULT_GEN_OPTS.maxTokens
    const temperature = (opts.temperature as number) ?? DEFAULT_GEN_OPTS.temperature
    const topP = (opts.topP as number) ?? DEFAULT_GEN_OPTS.topP
    const stopSequences = (opts.stopSequences as string[]) ?? []

    const grammar = opts.grammar as string | undefined
    if (grammar) {
      binding.setGrammar(grammar)
    }

    const tokens = binding.tokenize(prompt)
    const result = await binding.infer(tokens, maxTokens, temperature, topP)
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
