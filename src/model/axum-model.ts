import { AxumEngine } from "../engine/axum-engine.ts"
import type {
  Model,
  GenerateOpts,
  GenerateCallbacks,
  MoSEHandle,
  LoRAHandle,
  MoseBlendWeights,
  MoSEExpert,
  MoSEConfig,
  LoRAExpertConfig,
  LoRASwitchRequest,
} from "../types.ts"

export class AxumModel implements Model {
  private engine: AxumEngine

  constructor(axumUri: string = "ws://127.0.0.1:5678/ws") {
    // For axum, modelPath is the server URL, we don't need local model files
    this.engine = new AxumEngine("axum", ".", axumUri)
  }

  async init(gpu?: string, loraPaths?: unknown): Promise<void> {
    await this.engine.init(gpu, loraPaths)
  }

  async dispose(): Promise<void> {
    await this.engine.dispose()
  }

  tokenize(text: string): number[] {
    return this.engine.tokenize(text)
  }

  detokenize(tokens: number[]): string {
    return this.engine.detokenize(tokens)
  }

  async generate(prompt: string, opts?: Record<string, unknown>): Promise<string> {
    return this.engine.generate(prompt, opts)
  }

  async generateStream(
    prompt: string,
    callbacks: GenerateCallbacks = {},
    opts?: Record<string, unknown>
  ): Promise<string> {
    return this.engine.generateStream(prompt, callbacks, opts)
  }

  async evaluate(text: string): Promise<void> {
    await this.engine.evaluate(text)
  }

  async saveCheckpoint(name: string): Promise<{ filePath: string; fileSize: number }> {
    return this.engine.saveCheckpoint(name)
  }

  async loadCheckpoint(name: string): Promise<void> {
    await this.engine.loadCheckpoint(name)
  }

  statePath(name: string): string {
    return this.engine.statePath(name)
  }

  async bakeSystemPrompt(systemPrompt: string): Promise<{ baselinePath: string; fileSize: number }> {
    return this.engine.bakeSystemPrompt(systemPrompt)
  }

  async loadBaseline(): Promise<void> {
    await this.engine.loadBaseline()
  }

  getStateSize(): number {
    return this.engine.getStateSize()
  }

  generateWithBlend(
    prompt: string,
    blend?: MoseBlendWeights,
    opts?: Record<string, unknown>
  ): Promise<string> {
    return this.engine.generateWithBlend(prompt, blend, opts)
  }

  generateWithSegments(
    segments: { text: string; blend: MoseBlendWeights }[],
    opts?: Record<string, unknown>
  ): Promise<string> {
    return this.engine.generateWithSegments(segments, opts)
  }

  get mose(): MoSEHandle {
    return this.engine.mose
  }

  get loraMgr(): LoRAHandle {
    return this.engine.loraMgr
  }
}