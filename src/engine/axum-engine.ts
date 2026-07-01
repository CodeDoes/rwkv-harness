import { promises as fsp } from "fs"
import { AxumSession, createAxumSession } from "./axum-session.ts"
import type { Model, GenerateOpts, GenerateCallbacks, MoSEHandle, LoRAHandle, MoseBlendWeights, MoSEExpert, MoSEConfig, LoRAExpertConfig, LoRASwitchRequest } from "../types.ts"

interface VocabEntry {
  token: string
  id: number
}

const DEFAULT_GEN_OPTS: GenerateOpts = {
  maxTokens: 1024,
  temperature: 0.8,
  topP: 0.9,
  repeatPenalty: 1.1,
  frequencyPenalty: 0.1,
  presencePenalty: 0,
}

export class AxumEngine implements Model {
  private session: AxumSession
  private vocab: Map<string, number> = new Map()
  private idToToken: Map<number, string> = new Map()
  private stateId: string
  private pipelineId: string
  private samplerId: string
  private transformerIds: string[] = []
  private terminalId: string
  private initialized = false

  constructor(
    private modelPath: string,
    private sessionDir: string,
    private axumUri: string = "ws://127.0.0.1:5678/ws",
    private vocabPath: string = "assets/rwkv_vocab_v20230424.json"
  ) {
    this.session = createAxumSession(axumUri)
    this.stateId = `state-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    this.pipelineId = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    this.samplerId = `sampler-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    this.terminalId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }

  async init(gpu?: string, loraPaths?: unknown): Promise<void> {
    if (this.initialized) return

    // Load vocab
    await this.loadVocab()

    // Connect to axum server
    await this.session.connect()

    // Create state
    await this.session.createState(this.stateId)

    // Create sampler (nucleus with reasonable defaults)
    await this.session.createSampler(this.samplerId, "nucleus", {
      temp: 0.8,
      top_p: 0.9,
    })

    // Create terminal (lengthed with max tokens)
    await this.session.createTerminal(this.terminalId, "lengthed", {
      length: 1024,
    })

    // Create pipeline with just sampler + terminal for now
    // BNF grammar transformers will be added per-generation
    await this.session.createPipeline(
      this.pipelineId,
      [[]], // no transformers by default
      { type_id: "nucleus", params: { temp: 0.8, top_p: 0.9 } },
      { type_id: "lengthed", params: { length: 1024 } }
    )

    this.initialized = true
  }

  private async loadVocab(): Promise<void> {
    try {
      const text = await fsp.readFile(this.vocabPath, "utf-8")
      const vocab: Record<string, number> = JSON.parse(text)
      for (const [token, id] of Object.entries(vocab)) {
        this.vocab.set(token, id)
        this.idToToken.set(id, token)
      }
    } catch (e) {
      console.warn("Could not load vocab, tokenization will be limited:", e)
    }
  }

  async dispose(): Promise<void> {
    await this.session.close()
  }

  tokenize(text: string): number[] {
    if (this.vocab.size === 0) {
      return Array.from(new TextEncoder().encode(text))
    }
    // Simplified tokenization - in production use proper BPE
    return Array.from(new TextEncoder().encode(text))
  }

  detokenize(tokens: number[]): string {
    if (this.idToToken.size === 0) {
      return new TextDecoder().decode(new Uint16Array(tokens))
    }
    return tokens.map(t => this.idToToken.get(t) || "").join("")
  }

  async generate(prompt: string, opts?: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.init()
    let result = ""
    await this.generateStream(prompt, { onText: (t) => { result += t } }, opts)
    return result
  }

  async generateStream(
    prompt: string,
    callbacks: GenerateCallbacks = {},
    opts: Record<string, unknown> = {}
  ): Promise<string> {
    if (!this.initialized) await this.init()

    // If grammar is provided, create BNF transformer and add to pipeline
    const grammar = opts.grammar as string | undefined
    if (grammar) {
      const tfId = `bnf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      await this.session.createBnfGrammar(tfId, grammar)
      this.transformerIds.push(tfId)

      // Recreate pipeline with the new transformer
      await this.session.createPipeline(
        this.pipelineId,
        [[{ type_id: "bnf_grammar", params: {
          grammar,
          stack_arena_capacity: 1024,
          grammar_stack_arena_capacity: 1024,
          start_nonterminal: "root",
          stack_to_bytes_cache_enabled: true,
        } }]],
        { type_id: "nucleus", params: { temp: opts.temperature || 0.8, top_p: opts.topP || 0.9 } },
        { type_id: "lengthed", params: { length: opts.maxTokens || 1024 } }
      )
    }

    const inferPayload = {
      tokens: [prompt],
      states: [this.stateId],
      pipeline: this.pipelineId,
      update_prompt: true,
      reset_on_exhaustion: true,
      timeout: 60000,
    }

    const result = await this.session.infer(inferPayload)

    callbacks.onRawOutput?.(result.result)
    callbacks.onText?.(result.result)
    callbacks.onDone?.()

    return result.result
  }

  async evaluate(text: string): Promise<void> {
    await this.session.updateState([this.stateId], [text])
  }

  async saveCheckpoint(name: string): Promise<{ filePath: string; fileSize: number }> {
    const dumpId = `${this.sessionDir}/${name}.st`
    await this.session.dumpState(this.stateId, dumpId)
    const stat = await fsp.stat(dumpId)
    return { filePath: dumpId, fileSize: stat.size }
  }

  async loadCheckpoint(name: string): Promise<void> {
    const dumpId = `${this.sessionDir}/${name}.st`
    await this.session.deleteState(this.stateId)
    this.stateId = `state-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    await this.session.createState(this.stateId, dumpId)
  }

  statePath(name: string): string {
    return `${this.sessionDir}/${name}.st`
  }

  async bakeSystemPrompt(systemPrompt: string): Promise<{ baselinePath: string; fileSize: number }> {
    await this.session.updateState([this.stateId], [systemPrompt])
    const saved = await this.saveCheckpoint("_system_baseline")
    return { baselinePath: saved.filePath, fileSize: saved.fileSize }
  }

  async loadBaseline(): Promise<void> {
    await this.loadCheckpoint("_system_baseline")
  }

  getStateSize(): number {
    return 0 // RWKV state size is fixed but not easily queryable
  }

  // MoSE - not implemented for axum
  async generateWithBlend(
    prompt: string,
    blend?: MoseBlendWeights,
    opts?: Record<string, unknown>
  ): Promise<string> {
    return this.generate(prompt, opts)
  }

  async generateWithSegments(
    segments: { text: string; blend: MoseBlendWeights }[],
    opts?: Record<string, unknown>
  ): Promise<string> {
    const combined = segments.map(s => s.text).join("\n")
    return this.generate(combined, opts)
  }

  get mose(): MoSEHandle {
    return {
      createExpert: async () => { throw new Error("MoSE not supported on axum") },
      list: () => [],
      get: () => undefined,
      removeExpert: async () => false,
      setWeight: () => false,
      setWeights: () => {},
      apply: async () => {},
      segmentRoute: async () => {},
      dispose: async () => {},
    }
  }

  get loraMgr(): LoRAHandle {
    return {
      add: () => {},
      remove: () => false,
      list: () => [],
      getActive: () => [],
      activate: async () => {},
      deactivateAll: async () => {},
    }
  }
}

export function createAxumEngine(
  modelPath: string,
  sessionDir: string,
  axumUri?: string,
  vocabPath?: string
): AxumEngine {
  return new AxumEngine(modelPath, sessionDir, axumUri, vocabPath)
}