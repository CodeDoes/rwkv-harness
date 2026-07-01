#!/usr/bin/env node
import * as path from "path"
import { fileURLToPath } from "url"
import { InferenceServer } from "./src/inference/server.ts"
import type { BackendConfig } from "./src/inference/backend.ts"
import { promises as fsp } from "fs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname)

const args = process.argv.slice(2)
const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] || "3210", 10)
const slotsDir = args.find((a) => a.startsWith("--slots-dir="))?.split("=")[1] || path.join(PROJECT_ROOT, "inference-slots", String(port))
const maxConcurrency = parseInt(args.find((a) => a.startsWith("--max-concurrency="))?.split("=")[1] || "4", 10)
const hardMaxTokens = parseInt(args.find((a) => a.startsWith("--max-tokens="))?.split("=")[1] || "4096", 10)
const idleTimeoutMs = parseInt(args.find((a) => a.startsWith("--idle-timeout="))?.split("=")[1] || "300000", 10)

async function main() {
  await fsp.mkdir(slotsDir, { recursive: true })
  const pidFile = path.join(PROJECT_ROOT, `inference-${port}.pid`)
  await fsp.writeFile(pidFile, String(process.pid))

  const config: BackendConfig = {
    maxConcurrency,
    hardMaxTokens,
    idleTimeoutMs,
  }

  const server = new InferenceServer(slotsDir, config)
  console.error(
    `Inference server | port=${port} | max-concurrency=${maxConcurrency} | ` +
    `max-tokens=${hardMaxTokens} | idle-timeout=${(idleTimeoutMs / 1000).toFixed(0)}s`
  )

  const cleanup = async () => {
    console.error("\nShutting down inference API...")
    await server.stop()
    try { await fsp.unlink(pidFile) } catch { /* */ }
    process.exit(0)
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
  await server.start(port)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(1)
})