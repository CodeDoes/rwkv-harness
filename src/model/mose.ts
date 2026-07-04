import { promises as fsp } from "fs"
import * as fs from "fs"
import * as path from "path"
import type { Engine, MoSEConfig, MoSEExpert, MoseBlendWeights, MoSEHandle, LoRAHandle } from "../types.ts"

export class MoSEEngine implements MoSEHandle {
  private model: Engine
  private stateDir: string
  private experts: Map<string, MoSEExpert> = new Map()

  constructor(model: Engine, stateDir: string) {
    this.model = model
    this.stateDir = stateDir
  }

  private expertPath(name: string): string {
    return path.join(this.stateDir, `_expert_${name}.state`)
  }

  /** List all registered experts. */
  list(): MoSEExpert[] {
    return Array.from(this.experts.values())
  }

  /** Get registered expert by name. */
  get(name: string): MoSEExpert | undefined {
    return this.experts.get(name)
  }

  async createExpert(name: string, text: string, weight: number = 1.0): Promise<MoSEExpert> {
    const statePath = this.expertPath(name)

    const tempRestore = `_mose_restore_${Date.now()}`
    await this.model.saveCheckpoint(tempRestore)

    try {
      await this.model.loadBaseline()
      await this.model.evaluate(text)
      const info = await this.model.saveCheckpoint(`_expert_${name}`)
      await fsp.copyFile(info.filePath, statePath)
    } finally {
      await this.model.loadCheckpoint(tempRestore)
      try {
        await fsp.unlink(this.model.statePath(tempRestore))
      } catch { }
    }

    const expert: MoSEExpert = { name, stateFile: statePath, weight }
    this.experts.set(name, expert)
    return expert
  }

  async loadExpert(name: string, stateFilePath: string, weight: number = 1.0): Promise<MoSEExpert> {
    const stat = await fsp.stat(stateFilePath).catch(() => null)
    if (!stat) throw new Error(`State file not found: ${stateFilePath}`)

    const dest = this.expertPath(name)
    await fsp.copyFile(stateFilePath, dest)

    const expert: MoSEExpert = { name, stateFile: dest, weight }
    this.experts.set(name, expert)
    return expert
  }

  async removeExpert(name: string): Promise<boolean> {
    const expert = this.experts.get(name)
    if (!expert) return false
    await fsp.unlink(expert.stateFile).catch(() => { })
    this.experts.delete(name)
    return true
  }

  setWeight(name: string, weight: number): boolean {
    const expert = this.experts.get(name)
    if (!expert) return false
    expert.weight = weight
    return true
  }

  setWeights(weights: MoseBlendWeights): void {
    for (const [name, weight] of Object.entries(weights)) {
      this.setWeight(name, weight)
    }
  }

  async blend(weights?: MoseBlendWeights): Promise<string> {
    if (this.experts.size === 0) {
      throw new Error("No experts registered")
    }

    if (weights) this.setWeights(weights)

    const active = this.list().filter((e) => e.weight !== 0)
    if (active.length === 0) {
      throw new Error("All experts have weight 0")
    }

    const fileData = await Promise.all(
      active.map((e) => fsp.readFile(e.stateFile))
    )

    const elemCount = fileData[0].byteLength / 4
    const result = new Float32Array(elemCount)

    let wsum = 0
    for (let i = 0; i < active.length; i++) {
      const floats = new Float32Array(fileData[i].buffer, fileData[i].byteOffset, elemCount)
      const w = active[i].weight
      wsum += w
      for (let j = 0; j < elemCount; j++) {
        result[j] += floats[j] * w
      }
    }

    if (wsum > 0 && Math.abs(wsum - 1.0) > 1e-6) {
      for (let j = 0; j < elemCount; j++) {
        result[j] /= wsum
      }
    }

    const outputPath = this.model.statePath("_mose_blend")
    await fsp.writeFile(outputPath, Buffer.from(result.buffer))
    return outputPath
  }

  async apply(weights?: MoseBlendWeights): Promise<void> {
    await this.blend(weights)
    await this.model.loadCheckpoint("_mose_blend")
  }

  async segmentRoute(segments: { text: string; blend: MoseBlendWeights }[]): Promise<void> {
    for (const seg of segments) {
      await this.apply(seg.blend)
      await this.model.evaluate(seg.text)
    }
  }

  async dispose(): Promise<void> {
    for (const expert of this.experts.values()) {
      await fsp.unlink(expert.stateFile).catch(() => { })
    }
    this.experts.clear()
  }
}

export class LoRAManager implements LoRAHandle {
  private adapters: Map<string, { filePath: string; scale: number }> = new Map()
  private active: string[] = []

  constructor(_model: Engine) { }

  add(name: string, filePath: string, scale: number = 1.0): void {
    this.adapters.set(name, { filePath, scale })
  }

  remove(name: string): boolean {
    return this.adapters.delete(name)
  }

  list(): { name: string; filePath: string; scale: number }[] {
    return Array.from(this.adapters.entries()).map(([name, cfg]) => ({ name, ...cfg }))
  }

  getActive(): string[] {
    return [...this.active]
  }

  async activate(...names: string[]): Promise<void> {
    if (names.length === 0) return
    console.error("Warning: LoRA runtime switching not supported on native backend. LoRA must be loaded at model init via --lora=")
    this.active = [...names]
  }

  async deactivateAll(): Promise<void> {
    this.active = []
  }
}