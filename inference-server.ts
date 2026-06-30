#!/usr/bin/env node
import * as path from "path"
import { fileURLToPath } from "url"
import { InferenceServer } from "./src/inference/server.ts"
import { promises as fsp } from "fs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname)

const args = process.argv.slice(2)
const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] || "3210", 10)
const slotsDir = args.find((a) => a.startsWith("--slots-dir="))?.split("=")[1] || path.join(PROJECT_ROOT, "inference-slots", String(port))

async function main() {
  await fsp.mkdir(slotsDir, { recursive: true })
  const pidFile = path.join(PROJECT_ROOT, `inference-${port}.pid`)
  await fsp.writeFile(pidFile, String(process.pid))
  const server = new InferenceServer(slotsDir, port)
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