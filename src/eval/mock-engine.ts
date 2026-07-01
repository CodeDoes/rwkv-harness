import type { Model, GenerateCallbacks, MoseBlendWeights, MoSEHandle, LoRAHandle } from "../types.ts"

export class MockModel implements Model {
  private responses: string[]
  private callIndex = 0
  public prompts: string[] = []
  public opts: unknown[] = []

  constructor(responses: string[]) {
    this.responses = responses
  }

  async init(_gpu?: string, _loraPaths?: unknown): Promise<void> {}
  async dispose(): Promise<void> {}
  tokenize(_text: string): number[] { return [] }
  detokenize(_tokens: number[]): string { return "" }

  async generate(prompt: string, _opts: unknown = {}): Promise<string> {
    this.prompts.push(prompt)
    const response = this.responses[this.callIndex]
    this.callIndex++
    if (response === undefined) {
      throw new Error(
        `MockModel: out of responses (called ${this.callIndex} times, only ${this.responses.length} responses)`,
      )
    }
    return response
  }

  async generateStream(_prompt: string, callbacks?: GenerateCallbacks, _opts?: Record<string, unknown>): Promise<string> {
    const result = await this.generate(_prompt)
    callbacks?.onText?.(result)
    callbacks?.onDone?.()
    return result
  }

  async evaluate(_text: string): Promise<void> {}
  async saveCheckpoint(_name: string): Promise<{ filePath: string; fileSize: number }> {
    return { filePath: "", fileSize: 0 }
  }
  async loadCheckpoint(_name: string): Promise<void> {}
  statePath(_name: string): string { return "" }
  async bakeSystemPrompt(_text: string): Promise<{ baselinePath: string; fileSize: number }> {
    return { baselinePath: "", fileSize: 0 }
  }
  async loadBaseline(): Promise<void> {}
  getStateSize(): number { return 0 }

  async generateWithBlend(prompt: string, _blend?: MoseBlendWeights, _opts?: Record<string, unknown>): Promise<string> {
    return this.generate(prompt)
  }
  async generateWithSegments(
    _segments: { text: string; blend: MoseBlendWeights }[],
    _opts?: Record<string, unknown>,
  ): Promise<string> {
    return this.generate("")
  }

  mose: MoSEHandle = {} as MoSEHandle
  loraMgr: LoRAHandle = {} as LoRAHandle

  get callCount(): number {
    return this.callIndex
  }
}
