import WebSocket from "ws"
import { EventEmitter } from "events"

interface Response {
  echo_id: string
  status: "success" | "error"
  duration_ms?: number
  result?: any
  error?: string
}

interface InferPayload {
  tokens: Array<string | number | Array<string | number>>
  states: string[]
  pipeline: string
  update_prompt?: boolean
  reset_on_exhaustion?: boolean | { transformers: boolean[]; sampler: boolean; normalizer: boolean }
  timeout?: number
}

interface InferResult {
  result: string
  last_token: number
  inferred_tokens: number
  prompt_tokens: number
  end_reason: "by_terminal" | "by_exhaustion" | "by_eof" | "by_max_token"
}

export class AxumSession extends EventEmitter {
  private ws: WebSocket | null = null
  private pending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }> = new Map()
  private uri: string
  private echoCounter = 0

  constructor(uri: string = "ws://127.0.0.1:5678/ws") {
    super()
    this.uri = uri
  }

  async connect(): Promise<void> {
    if (this.ws) return
    this.ws = new WebSocket(this.uri)
    await new Promise<void>((resolve, reject) => {
      this.ws!.on("open", () => resolve())
      this.ws!.on("error", reject)
    })
    this.ws.on("message", (data: Buffer) => this.handleMessage(data.toString()))
  }

  async close(): Promise<void> {
    if (this.ws) {
      await this.ws.close()
      this.ws = null
    }
  }

  private handleMessage(msg: string): void {
    try {
      const resp: Response = JSON.parse(msg)
      const pending = this.pending.get(resp.echo_id)
      if (pending) {
        this.pending.delete(resp.echo_id)
        if (resp.status === "success") {
          pending.resolve(resp.result)
        } else {
          pending.reject(new Error(resp.error || "Unknown error"))
        }
      }
    } catch (e) {
      console.error("Failed to parse response:", msg, e)
    }
  }

  async call(command: string, data: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected")
    }
    const echo_id = `${Date.now()}-${this.echoCounter++}`
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(echo_id, { resolve, reject })
    })
    this.ws.send(JSON.stringify({ echo_id, command, data }))
    return promise
  }

  // State management
  async createState(id?: string, dumpId?: string): Promise<string> {
    const result = await this.call("create_state", { id, dump_id: dumpId })
    return id || result.state_id
  }

  async deleteState(id: string): Promise<void> {
    await this.call("delete_state", id)
  }

  async copyState(src: string, dst?: string, shallow = false): Promise<string> {
    const result = await this.call("copy_state", { source: src, destination: dst, shallow })
    return result.state_id
  }

  async updateState(states: string[], tokens: Array<string | Array<string | number>>, probsDist?: number[]): Promise<number[][] | null> {
    const result = await this.call("update_state", { states, tokens, probs_dist: probsDist })
    return result?.result || null
  }

  async dumpState(stateId: string, dumpId: string): Promise<void> {
    await this.call("dump_state", { state_id: stateId, dump_id: dumpId })
  }

  // Sampler
  async createSampler(id: string, typeId: string, params: any): Promise<void> {
    await this.call("create_sampler", { id, data: { type_id: typeId, params } })
  }

  async deleteSampler(id: string): Promise<void> {
    await this.call("delete_sampler", id)
  }

  // Transformer
  async createTransformer(id: string, typeId: string, params: any): Promise<void> {
    await this.call("create_transformer", { id, data: { type_id: typeId, params } })
  }

  async deleteTransformer(id: string): Promise<void> {
    await this.call("delete_transformer", id)
  }

  // Terminal
  async createTerminal(id: string, typeId: string, params: any): Promise<void> {
    await this.call("create_terminal", { id, data: { type_id: typeId, params } })
  }

  async deleteTerminal(id: string): Promise<void> {
    await this.call("delete_terminal", id)
  }

  // Pipeline
  async createPipeline(
    id: string,
    transformers: Array<Array<{ type_id: string; params: any }>>,
    sampler: { type_id: string; params: any },
    terminal: { type_id: string; params: any },
    normalizer?: { type_id: string; params: any }
  ): Promise<void> {
    await this.call("create_pipeline", {
      id,
      transformers,
      sampler,
      terminal,
      normalizer: normalizer || null,
    })
  }

  async deletePipeline(id: string): Promise<void> {
    await this.call("delete_pipeline", id)
  }

  // Inference
  async infer(payload: InferPayload): Promise<InferResult> {
    return this.call("infer", payload)
  }

  // Helper: create BNF grammar transformer
  async createBnfGrammar(
    id: string,
    grammar: string,
    options?: {
      stackArenaCapacity?: number
      grammarStackArenaCapacity?: number
      startNonterminal?: string
      stackToBytesCacheEnabled?: boolean
    }
  ): Promise<void> {
    await this.createTransformer(id, "bnf_grammar", {
      grammar,
      stack_arena_capacity: options?.stackArenaCapacity || 1024,
      grammar_stack_arena_capacity: options?.grammarStackArenaCapacity || 1024,
      start_nonterminal: options?.startNonterminal || "root",
      stack_to_bytes_cache_enabled: options?.stackToBytesCacheEnabled ?? true,
    })
  }
}

export function createAxumSession(uri?: string): AxumSession {
  return new AxumSession(uri)
}