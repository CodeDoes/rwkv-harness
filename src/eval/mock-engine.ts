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
  /** When set, responses longer than this (in chars) are truncated
   *  and returned with stopReason="length". The remainder is queued
   *  as the next response to simulate max_length continuation. */
  private truncationCharLimit?: number

  constructor(responses: string[], truncationCharLimit?: number) {
    this.responses = [...responses]
    this.truncationCharLimit = truncationCharLimit
  }

  /** The current number of responses in the queue (changes after splits). */
  get responseCount(): number {
    return this.responses.length
  }

  async init(_gpu?: string, _loraPaths?: unknown): Promise<void> {}
  async dispose(): Promise<void> {}
  tokenize(_text: string): number[] { return [] }
  detokenize(_tokens: number[]): string { return "" }

  async process(_opts?: ProcessOpts): Promise<{ sessionId: string }> {
    return { sessionId: this.defaultSessionId }
  }

  private respond(response: string, onToken?: (t: string) => void): GenerateResult {
    if (this.truncationCharLimit && response.length > this.truncationCharLimit) {
      const truncated = response.slice(0, this.truncationCharLimit)
      const remainder = response.slice(this.truncationCharLimit)
      // Insert remainder after the current position so the next call gets it
      this.responses.splice(this.callIndex, 0, remainder)
      onToken?.(truncated)
      return { sessionId: this.defaultSessionId, text: truncated, stopReason: "length" }
    }
    onToken?.(response)
    return { sessionId: this.defaultSessionId, text: response, stopReason: "stop" }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.prompts.push(req.prompt)
    if (this.aborted.has(req.sessionId) || req.signal?.aborted) {
      return { sessionId: req.sessionId, text: "", stopReason: "abort" }
    }
    if (this.callIndex >= this.responses.length) {
      throw new Error(
        `MockModel: out of responses (called ${this.callIndex + 1} times, only ${this.responses.length} responses)`,
      )
    }
    const response = this.responses[this.callIndex]
    this.callIndex++
    return this.respond(response)
  }

  async streamGenerate(req: StreamGenerateRequest): Promise<GenerateResult> {
    this.prompts.push(req.prompt)
    if (this.aborted.has(req.sessionId) || req.signal?.aborted) {
      return { sessionId: req.sessionId, text: "", stopReason: "abort" }
    }
    if (this.callIndex >= this.responses.length) {
      throw new Error(
        `MockModel: out of responses (called ${this.callIndex + 1} times, only ${this.responses.length} responses)`,
      )
    }
    const response = this.responses[this.callIndex]
    this.callIndex++
    return this.respond(response, req.onToken)
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

  /**
   * The mock model has no tokenizer, so a real schoolmarm walk is not
   * available. We `throw` so eval controllers can detect the gap and
   * fall back to the regex-based lenient validator. Callers in oracle
   * eval should check `engine.grammarCheck === undefined` (or wrap in
   * try/catch) before relying on the result.
   */
  async grammarCheck(_gbnf: string, _text: string): Promise<{
    ok: boolean
    firstFail: number
    acceptedTokens: number
    remainingTokens: number
  }> {
    throw new Error("MockModel: no tokenizer available for grammar walk; use validateAssistantOutputLenient as fallback")
  }

  mose: MoSEHandle = {} as MoSEHandle
  loraMgr: LoRAHandle = {} as LoRAHandle

  get callCount(): number {
    return this.callIndex
  }
}
