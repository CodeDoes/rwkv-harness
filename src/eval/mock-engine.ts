import type {
  Engine,
  GenerateRequest,
  GenerateResult,
  MoSEHandle,
  LoRAHandle,
  ProcessOpts,
  StreamGenerateRequest,
} from "../types.ts"

export class MockModel implements Engine {
  private responses: string[]
  private callIndex = 0
  public prompts: string[] = []
  public interruptCount = 0
  private defaultSessionId = "mock-default-sid"
  private aborted = new Set<string>()

  constructor(responses: string[]) {
    this.responses = responses
  }

  async init(_gpu?: string, _loraPaths?: unknown): Promise<void> {}
  async dispose(): Promise<void> {}
  tokenize(_text: string): number[] { return [] }
  detokenize(_tokens: number[]): string { return "" }

  async process(_opts?: ProcessOpts): Promise<{ sessionId: string }> {
    return { sessionId: this.defaultSessionId }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.prompts.push(req.prompt)
    if (this.aborted.has(req.sessionId) || req.signal?.aborted) {
      return { sessionId: req.sessionId, text: "", stopReason: "abort" }
    }
    const response = this.responses[this.callIndex]
    this.callIndex++
    if (response === undefined) {
      throw new Error(
        `MockModel: out of responses (called ${this.callIndex} times, only ${this.responses.length} responses)`,
      )
    }
    return { sessionId: req.sessionId, text: response, stopReason: "stop" }
  }

  async streamGenerate(req: StreamGenerateRequest): Promise<GenerateResult> {
    this.prompts.push(req.prompt)
    if (this.aborted.has(req.sessionId) || req.signal?.aborted) {
      return { sessionId: req.sessionId, text: "", stopReason: "abort" }
    }
    const response = this.responses[this.callIndex]
    this.callIndex++
    if (response === undefined) {
      throw new Error(
        `MockModel: out of responses (called ${this.callIndex} times, only ${this.responses.length} responses)`,
      )
    }
    req.onToken?.(response)
    return { sessionId: req.sessionId, text: response, stopReason: "stop" }
  }

  async interrupt(sessionId: string): Promise<{ stopReason: "Interrupted" }> {
    this.interruptCount++
    this.aborted.add(sessionId)
    return { stopReason: "Interrupted" }
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

  mose: MoSEHandle = {} as MoSEHandle
  loraMgr: LoRAHandle = {} as LoRAHandle

  get callCount(): number {
    return this.callIndex
  }
}
