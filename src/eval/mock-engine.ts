export class MockModel {
  private responses: string[]
  private callIndex = 0
  public prompts: string[] = []
  public opts: unknown[] = []

  constructor(responses: string[]) {
    this.responses = responses
  }

  async generate(prompt: string, opts: unknown = {}): Promise<string> {
    this.prompts.push(prompt)
    this.opts.push(opts)
    const response = this.responses[this.callIndex]
    this.callIndex++
    if (response === undefined) {
      throw new Error(
        `MockEngine: out of responses (called ${this.callIndex} times, only ${this.responses.length} responses)`,
      )
    }
    return response
  }

  get callCount(): number {
    return this.callIndex
  }
}
