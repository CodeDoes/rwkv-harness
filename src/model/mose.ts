import { promises as fsp } from "fs"
import * as fs from "fs"
import * as path from "path"
import { RwkvModel } from "./rwkv-model.ts"
import type { MoSEConfig, MoSEExpert, MoseBlendWeights, MoSEHandle, LoRAHandle } from "../types.ts"

/**
 * MoSE — Mixture of State Experts via binary state blending.
 *
 * Creates expert states from text prompts, then blends them at the
 * binary level (weighted float32 sum) before loading into the sequence.
 * Single forward pass cost regardless of expert count.
 *
 * ## How it works
 *
 * 1. `createExpert(name, text)` — saves current state, loads baseline,
 *    evaluates text through model, saves result as expert `.state` file,
 *    restores original state.
 * 2. `blend(weights)` — reads N expert state files, does element-wise
 *    weighted float32 sum, writes blended state to temp file.
 * 3. `apply(sequence)` — loads blended state into active sequence.
 *
 * State files are opaque binary blobs from llama.cpp
 * (`sequence.saveStateToFile`). For RWKV models these are purely the
 * recurrent state tensors (float32), so element-wise blending is safe.
 */
export class MoSEEngine implements MoSEHandle {
  private model: RwkvModel
  private stateDir: string
  private experts: Map<string, MoSEExpert> = new Map()

  constructor(model: RwkvModel, stateDir: string) {
    this.model = model
    this.stateDir = stateDir
  }

  private expertPath(name: string): string {
    return path.join(this.stateDir, `_expert_${name}.state`)
  }

  private blendPath(): string {
    return path.join(this.stateDir, `_mose_blend.state`)
  }

  /** List all registered experts. */
  list(): MoSEExpert[] {
    return Array.from(this.experts.values())
  }

  /** Get registered expert by name. */
  get(name: string): MoSEExpert | undefined {
    return this.experts.get(name)
  }

  /**
   * Create an expert state from text.
   *
   * Saves current sequence state, loads baseline, evaluates text,
   * saves result as expert state file, restores original.
   */
  async createExpert(name: string, text: string, weight: number = 1.0): Promise<MoSEExpert> {
    const seq = this.model.sequence
    const statePath = this.expertPath(name)

    // Save current state so we can restore after baking
    const tempRestore = path.join(this.stateDir, `_mose_restore_${Date.now()}.state`)
    await seq.saveStateToFile(tempRestore)

    try {
      // Load baseline as starting state for expert
      const baselinePath = path.join(this.stateDir, "_system_baseline.state")
      const hasBaseline = fs.existsSync(baselinePath)
      if (hasBaseline) {
        await seq.loadStateFromFile(baselinePath, { acceptRisk: true })
      }

      // Bake expert text into state
      const tokens = this.model.tokenize(text)
      await seq.evaluateWithoutGeneratingNewTokens(tokens)
      await seq.saveStateToFile(statePath)
    } finally {
      // Restore original state
      await seq.loadStateFromFile(tempRestore, { acceptRisk: true })
      await fsp.unlink(tempRestore).catch(() => {})
    }

    const expert: MoSEExpert = { name, stateFile: statePath, weight }
    this.experts.set(name, expert)
    return expert
  }

  /**
   * Load an expert state from an existing `.state` file
   * (created outside this session).
   */
  async loadExpert(name: string, stateFilePath: string, weight: number = 1.0): Promise<MoSEExpert> {
    const stat = await fsp.stat(stateFilePath).catch(() => null)
    if (!stat) throw new Error(`State file not found: ${stateFilePath}`)

    // Copy to session directory for safe keeping
    const dest = this.expertPath(name)
    await fsp.copyFile(stateFilePath, dest)

    const expert: MoSEExpert = { name, stateFile: dest, weight }
    this.experts.set(name, expert)
    return expert
  }

  /** Remove an expert. */
  async removeExpert(name: string): Promise<boolean> {
    const expert = this.experts.get(name)
    if (!expert) return false
    await fsp.unlink(expert.stateFile).catch(() => {})
    this.experts.delete(name)
    return true
  }

  /** Set blend weight for an expert (does not save). */
  setWeight(name: string, weight: number): boolean {
    const expert = this.experts.get(name)
    if (!expert) return false
    expert.weight = weight
    return true
  }

  /** Set multiple weights at once. */
  setWeights(weights: MoseBlendWeights): void {
    for (const [name, weight] of Object.entries(weights)) {
      this.setWeight(name, weight)
    }
  }

  /**
   * Blend all expert states into a single state file.
   * Reads each expert's binary state, does weighted float32 sum,
   * writes result to temp file.
   *
   * Returns path to blended state file (caller should clean up).
   */
  async blend(weights?: MoseBlendWeights): Promise<string> {
    if (this.experts.size === 0) {
      throw new Error("No experts registered")
    }

    if (weights) this.setWeights(weights)

    const active = this.list().filter((e) => e.weight !== 0)
    if (active.length === 0) {
      throw new Error("All experts have weight 0")
    }

    const outputPath = this.blendPath()

    // Read all expert state files
    const fileData = await Promise.all(
      active.map((e) => fsp.readFile(e.stateFile))
    )

    const elemCount = fileData[0].byteLength / 4
    const result = new Float32Array(elemCount)

    // Weighted sum
    let wsum = 0
    for (let i = 0; i < active.length; i++) {
      const floats = new Float32Array(fileData[i].buffer, fileData[i].byteOffset, elemCount)
      const w = active[i].weight
      wsum += w
      for (let j = 0; j < elemCount; j++) {
        result[j] += floats[j] * w
      }
    }

    // Normalize by total weight
    if (wsum > 0 && Math.abs(wsum - 1.0) > 1e-6) {
      for (let j = 0; j < elemCount; j++) {
        result[j] /= wsum
      }
    }

    await fsp.writeFile(outputPath, Buffer.from(result.buffer))
    return outputPath
  }

  /**
   * Blend experts and load blended state into the active sequence.
   * Cleans up temp blend file after load.
   */
  async apply(weights?: MoseBlendWeights): Promise<void> {
    const blendFile = await this.blend(weights)
    await this.model.sequence.loadStateFromFile(blendFile, { acceptRisk: true })
    await fsp.unlink(blendFile).catch(() => {})
  }

  /**
   * Segment routing: process each prompt segment with a different
   * expert blend. Useful for multi-part prompts where each part
   * benefits from a different style/task state.
   *
   * Example: `segmentRoute([{text: systemPrompt, blend: {formal: 1}},
   *                         {text: userInput, blend: {creative: 0.7, precise: 0.3}}])`
   */
  async segmentRoute(segments: { text: string; blend: MoseBlendWeights }[]): Promise<void> {
    for (const seg of segments) {
      await this.apply(seg.blend)
      const tokens = this.model.tokenize(seg.text)
      await this.model.sequence.evaluateWithoutGeneratingNewTokens(tokens)
    }
  }

  /** Dispose all expert files. */
  async dispose(): Promise<void> {
    for (const expert of this.experts.values()) {
      await fsp.unlink(expert.stateFile).catch(() => {})
    }
    this.experts.clear()
    await fsp.unlink(this.blendPath()).catch(() => {})
  }
}


/**
 * MoLE — Mixture of LoRA Experts.
 *
 * Manages multiple LoRA adapter files and switches between them
 * using node-llama-cpp's private `_setLoras` API.
 *
 * Supports activating multiple adapters simultaneously (stacked)
 * and per-request scale adjustment.
 */
export class LoRAManager implements LoRAHandle {
  private model: RwkvModel
  private adapters: Map<string, { filePath: string; scale: number }> = new Map()
  private active: string[] = []

  constructor(model: RwkvModel) {
    this.model = model
  }

  /** Register a LoRA adapter file under a name. */
  add(name: string, filePath: string, scale: number = 1.0): void {
    this.adapters.set(name, { filePath, scale })
  }

  /** Remove a registered adapter. */
  remove(name: string): boolean {
    return this.adapters.delete(name)
  }

  /** List registered adapters. */
  list(): { name: string; filePath: string; scale: number }[] {
    return Array.from(this.adapters.entries()).map(([name, cfg]) => ({ name, ...cfg }))
  }

  /** Get currently active adapter names. */
  getActive(): string[] {
    return [...this.active]
  }

  /**
   * Activate one or more adapters by name.
   * Calls engine's setLora to hot-swap without recreating the context.
   */
  async activate(...names: string[]): Promise<void> {
    const paths: string[] = []
    const activeNames: string[] = []
    for (const name of names) {
      const adapter = this.adapters.get(name)
      if (!adapter) throw new Error(`LoRA adapter '${name}' not registered`)
      paths.push(adapter.filePath)
      activeNames.push(name)
    }
    if (paths.length > 0) {
      await this.model.setLora(paths)
    }
    this.active = activeNames
  }

  /** Deactivate all LoRA adapters. */
  async deactivateAll(): Promise<void> {
    // Load with empty array to clear LoRAs (or pass single no-op path)
    await this.model.setLora([])
    this.active = []
  }
}
