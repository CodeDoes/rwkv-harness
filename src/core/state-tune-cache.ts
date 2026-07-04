/**
 * State-tune content hash.
 *
 * Caches the "I have already baked these state-tune examples into RNN
 * state" decision. The expensive step is feeding the examples through
 * the model one token at a time; if the same examples are loaded again
 * on a fresh session, we can skip that work.
 *
 * Scope: this cache is only safe when `clear()` is called whenever the
 * RNN state has been mutated away from "just-loaded baseline + these
 * examples". Callers wire that into their own state-touch points.
 *
 * The cache stores:
 *   - a `hash → payload` map (in-memory, optionally persisted)
 *   - `get(hash)` returns whether this content was already baked
 *   - `set(hash)` records that it is now baked
 *   - `clear()` resets the entire cache (e.g. after a manual state-load)
 */
import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"

export interface StateTuneCacheOpts {
  /** Directory to persist under. Set to null to disable persistence. */
  persistDir?: string | null
}

interface CacheFile {
  version: 1
  entries: Record<string, { bytes: number; bakedAt: string }>
}

export class StateTuneCache {
  private entries = new Map<string, { bytes: number; bakedAt: string }>()
  private persistPath: string | null

  constructor(opts: StateTuneCacheOpts = {}) {
    this.persistPath = opts.persistDir
      ? path.join(opts.persistDir, "state-tune.baked.json")
      : null
    this.load()
  }

  /** SHA-256 hex of the concatenated state-tune payload. */
  static hash(systemPrompt: string | undefined, appendContent: string | undefined): string {
    const h = crypto.createHash("sha256")
    h.update(systemPrompt ?? "")
    h.update("\u0000")
    h.update(appendContent ?? "")
    return h.digest("hex")
  }

  /** True if this system+append combo has already been baked. */
  has(hash: string): boolean {
    return this.entries.has(hash)
  }

  /** Record that this combo is now baked. Idempotent. */
  set(hash: string, payload: { bytes: number }): void {
    this.entries.set(hash, { bytes: payload.bytes, bakedAt: new Date().toISOString() })
    this.save()
  }

  /** Drop everything (e.g. after a model reload or state-load). */
  clear(): void {
    this.entries.clear()
    this.save()
  }

  /** Drop a single entry (e.g. after a state-load reset). */
  forget(hash: string): void {
    this.entries.delete(hash)
    this.save()
  }

  size(): number {
    return this.entries.size
  }

  private load(): void {
    if (!this.persistPath) return
    try {
      const raw = fs.readFileSync(this.persistPath, "utf-8")
      const parsed = JSON.parse(raw) as CacheFile
      if (parsed.version !== 1) return
      for (const [k, v] of Object.entries(parsed.entries ?? {})) {
        this.entries.set(k, v)
      }
    } catch {
      // missing or corrupt → start empty
    }
  }

  private save(): void {
    if (!this.persistPath) return
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true })
      const payload: CacheFile = { version: 1, entries: Object.fromEntries(this.entries) }
      fs.writeFileSync(this.persistPath, JSON.stringify(payload, null, 2), "utf-8")
    } catch {
      // best-effort; an unwritable cache just means we re-evaluate next time
    }
  }
}

/** Default process-wide cache (reads from `.cache/state-tune`). */
let defaultCache: StateTuneCache | null = null

export function getDefaultStateTuneCache(): StateTuneCache {
  if (!defaultCache) {
    const persistDir = path.resolve(process.cwd(), ".cache", "state-tune")
    defaultCache = new StateTuneCache({ persistDir })
  }
  return defaultCache
}

export function resetDefaultStateTuneCache(): void {
  if (defaultCache) defaultCache.clear()
  defaultCache = null
}
