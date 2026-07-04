/**
 * InferenceClient — wraps a local or remote engine behind the cacheId protocol.
 *
 * Two implementations:
 *  - `LocalInferenceClient` — talks to the in-process engine (native binding).
 *  - `HttpInferenceClient` — talks to a remote inference server over oRPC.
 *
 * See ARCH.md §"InferenceClient + InferenceServerControl".
 */

import type { Engine, StreamGenerateRequest } from "../types.ts"
import type { CacheProtocol, InferenceServerControl } from "./protocol.ts"
import type { StopReason } from "../protocol/message-part.ts"

export type { CacheProtocol, InferenceServerControl }

/**
 * LocalInferenceClient — wraps an in-process `Engine` (native RWKV binding)
 * behind the cacheId protocol. Uses a single in-memory cache slot (the
 * engine's implicit RNN state) and saves/restores to disk on cacheId change.
 */
export class LocalInferenceClient implements CacheProtocol {
  private engine: Engine
  private currentCacheId: string | null = null
  private stateDir: string

  constructor(engine: Engine, stateDir: string) {
    this.engine = engine
    this.stateDir = stateDir
  }

  async cacheCreate(): Promise<{ cacheId: string }> {
    const cacheId = `cache_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.currentCacheId = cacheId
    return { cacheId }
  }

  async cacheDestroy(_cacheId: string): Promise<void> {
    // Single cache: nothing to free in the binding. The state just gets
    // overwritten on next use.
  }

  async cacheList(): Promise<{ cacheId: string }[]> {
    return this.currentCacheId ? [{ cacheId: this.currentCacheId }] : []
  }

  async cacheGet(cacheId: string): Promise<{ cacheId: string; found: boolean; tokenCount: number }> {
    return {
      cacheId,
      found: cacheId === this.currentCacheId,
      tokenCount: 0,
    }
  }

  /** Switch to a different cache, saving the current state if dirty. */
  private async ensureCache(cacheId: string): Promise<void> {
    if (cacheId === this.currentCacheId) return
    // Save current state (if any) to its own file
    if (this.currentCacheId) {
      try {
        await this.engine.saveCheckpoint(this.currentCacheId)
      } catch {
        // state may be blank (no tokens yet)
      }
    }
    this.currentCacheId = cacheId
    // Load the target cache's state (if it exists)
    try {
      await this.engine.loadCheckpoint(cacheId)
    } catch {
      // first use — start from blank state
    }
  }

  async cacheAppend(cacheId: string, text: string): Promise<void> {
    await this.ensureCache(cacheId)
    await this.engine.evaluate(text)
  }

  async cacheSaveState(cacheId: string, name?: string): Promise<{ path: string; size: number }> {
    await this.ensureCache(cacheId)
    const saved = await this.engine.saveCheckpoint(name ?? cacheId)
    return { path: saved.filePath, size: saved.fileSize }
  }

  async cacheLoadState(cacheId: string, name: string): Promise<void> {
    this.currentCacheId = cacheId
    await this.engine.loadCheckpoint(name)
  }

  async generate(opts: {
    cacheId: string
    prompt?: string
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
    grammar?: string
  }): Promise<{ text: string; stopReason: StopReason; cacheId: string }> {
    await this.ensureCache(opts.cacheId)
    const { sessionId } = await this.engine.process()
    const result = await this.engine.generate({
      sessionId,
      prompt: opts.prompt ?? "",
      opts: {
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        topP: opts.topP,
        stopSequences: opts.stopSequences,
        grammar: opts.grammar,
      },
    })
    return {
      text: result.text,
      stopReason: result.stopReason as StopReason,
      cacheId: opts.cacheId,
    }
  }

  async stream(opts: {
    cacheId: string
    prompt?: string
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
    grammar?: string
    onToken: (token: string) => void
  }): Promise<{ text: string; stopReason: StopReason; cacheId: string }> {
    await this.ensureCache(opts.cacheId)
    const { sessionId } = await this.engine.process()
    const result = await this.engine.streamGenerate({
      sessionId,
      prompt: opts.prompt ?? "",
      opts: {
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        topP: opts.topP,
        stopSequences: opts.stopSequences,
        grammar: opts.grammar,
      },
      onToken: opts.onToken,
    })
    return {
      text: result.text,
      stopReason: result.stopReason as StopReason,
      cacheId: opts.cacheId,
    }
  }

  async interrupt(cacheId: string): Promise<{ stopped: boolean }> {
    if (cacheId !== this.currentCacheId) return { stopped: false }
    // The engine's `interrupt` sets the abort flag; the next polling
    // tick in `generate` / `streamGenerate` picks it up.
    const result = await this.engine.interrupt(cacheId)
    return { stopped: result.stopReason === "Interrupted" }
  }

  async tokenize(text: string): Promise<number[]> {
    return this.engine.tokenize(text)
  }

  async detokenize(tokens: number[]): Promise<string> {
    return this.engine.detokenize(tokens)
  }
}

/**
 * Simple control for a local inference server process.
 * In single-process mode (default), the server IS the engine in memory.
 */
export class LocalServerControl implements InferenceServerControl {
  private engine: Engine | null = null
  private _listeners: Array<(status: any) => void> = []
  private _status: any = { status: "stopped", stateSize: 0, modelName: "", uptimeMs: 0 }

  setEngine(e: Engine): void {
    this.engine = e
    this._status = { ...this._status, status: "ok" }
  }

  async isRunning(): Promise<boolean> {
    return this.engine !== null
  }

  async start(): Promise<void> {
    this._status = { ...this._status, status: "ok" }
    this.emit()
  }

  async stop(): Promise<void> {
    this._status = { ...this._status, status: "stopped" }
    this.emit()
  }

  async restart(): Promise<void> {
    this._status = { ...this._status, status: "starting" }
    this.emit()
    await new Promise((r) => setTimeout(r, 100))
    this._status = { ...this._status, status: "ok" }
    this.emit()
  }

  async status(): Promise<any> {
    if (this.engine) {
      try {
        const stateSize = this.engine.getStateSize()
        return { ...this._status, stateSize }
      } catch {}
    }
    return { ...this._status }
  }

  onEvent(cb: (event: any) => void): () => void {
    this._listeners.push(cb)
    return () => {
      this._listeners = this._listeners.filter((l) => l !== cb)
    }
  }

  private emit(): void {
    for (const cb of this._listeners) cb(this._status)
  }
}

/**
 * HttpInferenceClient — placeholder for remote inference server integration.
 * Talks over oRPC to a remote server that implements the CacheProtocol.
 * Not yet wired.
 */
export class HttpInferenceClient implements CacheProtocol {
  // TODO: implement when inference server is extracted as a separate process.
  // For now, throws to signal that this mode is not yet available.
  private url: string

  constructor(url: string) {
    this.url = url
  }

  async cacheCreate(): Promise<{ cacheId: string }> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async cacheDestroy(_cacheId: string): Promise<void> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async cacheList(): Promise<{ cacheId: string }[]> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async cacheGet(_cacheId: string): Promise<any> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async cacheAppend(_cacheId: string, _text: string): Promise<void> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async cacheSaveState(_cacheId: string, _name?: string): Promise<any> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async cacheLoadState(_cacheId: string, _name: string): Promise<void> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async generate(_opts: any): Promise<any> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async stream(_opts: any): Promise<any> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async interrupt(_cacheId: string): Promise<any> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async tokenize(_text: string): Promise<number[]> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
  async detokenize(_tokens: number[]): Promise<string> {
    throw new Error("HttpInferenceClient: not implemented yet")
  }
}
