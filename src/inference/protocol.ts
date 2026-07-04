/**
 * Cache protocol — the wire-level interface between the gateway and the
 * inference server. The inference server is message-blind: it only knows
 * about `cacheId` (a handle to the in-VRAM RNN state), prompt strings, and
 * generation parameters.
 *
 * The gateway wraps these primitives with its own session / message-part /
 * agent orchestration layer.
 *
 * See ARCH.md §"Inference server".
 */

import { z } from "zod"
import type { StopReason } from "../protocol/message-part.ts"

// ── Primitives ──

export const CacheId = z.string().min(1)

export const GenerateOpts = z.object({
  maxTokens: z.number().int().positive().default(500),
  temperature: z.number().min(0).max(2).default(0.8),
  topP: z.number().min(0).max(1).default(0.9),
  stopSequences: z.array(z.string()).optional(),
  grammar: z.string().optional(),
})

export const GenerateResult = z.object({
  cacheId: z.string(),
  text: z.string(),
  stopReason: z.string(),
})

export const CacheInfo = z.object({
  cacheId: z.string(),
  found: z.boolean(),
  tokenCount: z.number().default(0),
})

// ── Server status ──

export const ServerStatus = z.object({
  status: z.union([
    z.literal("starting"),
    z.literal("ok"),
    z.literal("error"),
    z.literal("stopped"),
  ]),
  stateSize: z.number().default(0),
  modelName: z.string().default(""),
  uptimeMs: z.number().default(0),
  progress: z.string().optional(),   // e.g. "Loading model 27%"
})

// ── Token / state operations ──

export const TokenizeResult = z.object({
  tokens: z.array(z.number()),
})

export const DetokenizeResult = z.object({
  text: z.string(),
})

export const StateInfo = z.object({
  path: z.string(),
  size: z.number(),
})

// ── Cache protocol interface (used by InferenceClient) ──

export interface CacheProtocol {
  /** Create a new empty cache slot. Returns its cacheId. */
  cacheCreate(): Promise<{ cacheId: string }>

  /** Destroy a cache slot (frees any held resources). */
  cacheDestroy(cacheId: string): Promise<void>

  /** List all known cache slots. */
  cacheList(): Promise<{ cacheId: string }[]>

  /** Check if a cache slot exists. */
  cacheGet(cacheId: string): Promise<z.infer<typeof CacheInfo>>

  /**
   * Append more prompt text to the given cache. This does NOT generate;
   * it just extends the RNN state with the new text tokens.
   * Equivalent to `interrupt → evaluate(text)` in the old API.
   */
  cacheAppend(cacheId: string, text: string): Promise<void>

  /** Save the current RNN state of a cache to disk. */
  cacheSaveState(cacheId: string, name?: string): Promise<z.infer<typeof StateInfo>>

  /** Load an RNN state from disk into a cache. */
  cacheLoadState(cacheId: string, name: string): Promise<void>

  /** Generate tokens from the current cache state. */
  generate(opts: {
    cacheId: string
    prompt?: string       // if provided, appended before generation
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
    grammar?: string
  }): Promise<{ text: string; stopReason: StopReason; cacheId: string }>

  /** Streaming variant. Yields tokens as they arrive. */
  stream(opts: {
    cacheId: string
    prompt?: string
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
    grammar?: string
    onToken: (token: string) => void
  }): Promise<{ text: string; stopReason: StopReason; cacheId: string }>

  /** Interrupt any in-progress generation for the given cache. */
  interrupt(cacheId: string): Promise<{ stopped: boolean }>

  /** Tokenize text. */
  tokenize(text: string): Promise<number[]>

  /** Detokenize tokens. */
  detokenize(tokens: number[]): Promise<string>
}

export interface InferenceServerControl {
  isRunning(): Promise<boolean>
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  status(): Promise<z.infer<typeof ServerStatus>>
  /** Events: progress logs, state transitions, errors. */
  onEvent(cb: (event: z.infer<typeof ServerStatus>) => void): () => void  // returns unsub
}
