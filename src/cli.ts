#!/usr/bin/env node
import { promises as fsp } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { NativeRwkvModel } from "./model/native-rwkv-model.ts"
import { HttpModel } from "./model/http-model.ts"
import type { Engine } from "./types.ts"
import { Session } from "./session/session.ts"
import { SessionManager } from "./session/session-manager.ts"
import { StorytellerAgent } from "./agents/storyteller/index.ts"
import { AgentLoop } from "./agents/loop.ts"
import { SessionHost } from "./session/session-host.ts"
import { GatewayServer } from "./gateway/server.ts"
import { GatewayControl } from "./gateway/control.ts"
import { Tui } from "./tui/index.ts"
import { GenerateOpts, DEFAULT_GEN_OPTS } from "./types.ts"
import { LogStream } from "./core/log-stream.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, "..")
const SESSIONS_DIR = path.join(PROJECT_ROOT, "sessions")
const WEBAPP_DIR = path.join(PROJECT_ROOT, "src", "web")

const args = process.argv.slice(2)
const command = args[0]
const noGateway = args.includes("--no-gateway")
const gatewayAutoPort = 3030
const modelPath = args.find((a) => a.startsWith("--model="))?.split("=")[1]
  || path.join(PROJECT_ROOT, "models/rwkv7-g1h_preview4673-2.9b-20260701-ctx8192.st")
const story = args.find((a) => a.startsWith("--story="))?.split("=")[1] || "default"
const gpuArg = (args.find((a) => a.startsWith("--gpu="))?.split("=")[1] || "vulkan") as "vulkan" | "cuda" | "auto"
const loraRaw = args.find((a) => a.startsWith("--lora="))?.split("=")[1]
const loraPaths = loraRaw ? loraRaw.split(",").map((p) => p.startsWith("/") ? p : path.join(PROJECT_ROOT, p)) : undefined
const engineUrl = args.find((a) => a.startsWith("--engine-url="))?.split("=")[1]
const fixParagraphs = args.includes("--fix-paragraphs") || args.includes("-p")
const agentDepth = parseInt(args.find((a) => a.startsWith("--depth="))?.split("=")[1] || "5", 10)
const grammarPath = args.find((a) => a.startsWith("--grammar="))?.split("=")[1]
const gatewayPort = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] || "3030", 10)
const logFileArg = args.find((a) => a.startsWith("--log-file="))?.split("=")[1]
const input = args.slice(1).filter((a) => !a.startsWith("--")).join(" ")

function makeGrammarPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
}

async function main() {
  switch (command) {
    case "gateway":
      return runGateway()
    case "tui":
      return runTui()
    default:
      return runCli()
  }
}

async function tryGatewayAuto(gatewayPort: number): Promise<Engine | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${gatewayPort}/rpc/health`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) {
      console.error(`Model: gateway (http://127.0.0.1:${gatewayPort})`)
      return new HttpModel(`http://127.0.0.1:${gatewayPort}`)
    }
  } catch { /* no gateway */ }
  return null
}

async function createModel(modelPath: string, stateDir: string, isGateway = false): Promise<Engine> {
  if (engineUrl) {
    console.error(`Model: remote (${engineUrl})`)
    return new HttpModel(engineUrl)
  }
  // Gateway mode: load native model directly
  if (isGateway) {
    console.error(`Model: native RWKV (${path.basename(modelPath)})`)
    return new NativeRwkvModel(modelPath, stateDir)
  }
  // Client mode: always use gateway
  if (!noGateway) {
    const gw = await tryGatewayAuto(gatewayAutoPort)
    if (gw) return gw
  }
  // Auto-start gateway via GatewayControl
  console.error(`Gateway: starting on :${gatewayAutoPort}...`)
  const gwCtrl = new GatewayControl({
    modelPath,
    port: gatewayAutoPort,
    gpu: gpuArg,
    loraPaths,
  })
  await gwCtrl.start()
  console.error(`Gateway: ready on :${gatewayAutoPort}`)
  return new HttpModel(gwCtrl.url)
}

async function runGateway() {
  try {
    const r = await fetch(`http://127.0.0.1:${gatewayPort}/rpc/health`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) {
      console.error(`Gateway already running on port ${gatewayPort}`)
      process.exit(1)
    }
  } catch { /* no running gateway — good */ }

  // When the user passes --log-file=, tee stderr to that file too.
  // (Without an explicit arg, the shell redirect in `gateway:start` /
  // `inference:start` handles durability via `.gateway.log`.)
  const logStream = logFileArg ? new LogStream({ path: logFileArg, mirror: "stderr" }) : null
  const log = (msg: string) => {
    process.stderr.write(msg + "\n")
    logStream?.line(msg)
  }

  const gwStateDir = path.join(SESSIONS_DIR, "_gateway")
  log(`RWKV Gateway | port: ${gatewayPort} | model: ${path.basename(modelPath)}`)

  const model = await createModel(modelPath, gwStateDir, true)
  const host = new SessionHost(model, gwStateDir)
  const server = new GatewayServer(host, WEBAPP_DIR, modelPath)

  await server.start(gatewayPort)
  log(`  API:  http://0.0.0.0:${gatewayPort}`)
  log(`  WS:   ws://0.0.0.0:${gatewayPort}`)
  log(`  Web:  http://0.0.0.0:${gatewayPort}`)
  log(`  Loading model (health endpoint live)...`)

  await Promise.all([
    model.init(gpuArg, loraPaths),
    fsp.mkdir(gwStateDir, { recursive: true }),
  ])
  await host.init()
  server.markReady()
  log(`  Sessions: ${(await host.listSessions()).length}`)

  const shutdown = async () => {
    log("\nShutting down...")
    await server.stop()
    logStream?.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

async function runTui() {
  const mode = args.includes("--connect") ? "gateway_client" : "direct"
  const gatewayHost = args.find((a) => a.startsWith("--host="))?.split("=")[1]
  const session = new SessionManager(SESSIONS_DIR, story, modelPath)
  const sessionDir = session.sessionDirPath

  const tui = new Tui({
    modelPath,
    stateDir: sessionDir,
    story,
    gpu: gpuArg,
    loraPaths,
    fixParagraphs,
    agentDepth,
    grammar: grammarPath ? await fsp.readFile(makeGrammarPath(grammarPath), "utf-8") : undefined,
    gatewayPort,
    mode: mode as any,
    gatewayHost,
  })

  await tui.start()
}

async function runCli() {
  const session = new SessionManager(SESSIONS_DIR, story, modelPath)
  const sessionDir = session.sessionDirPath
  const model = await createModel(modelPath, sessionDir)
  const agent = new StorytellerAgent(model, session, { fixParagraphBreak: fixParagraphs })

  let cleanupAgent: () => Promise<void> = () => agent.dispose()
  let shutdown = false

  async function cleanup(signal: string) {
    if (shutdown) return
    shutdown = true
    console.error(`\n${signal} - saving state...`)
    await cleanupAgent()
    process.exit(0)
  }

  process.on("SIGINT", () => cleanup("SIGINT"))
  process.on("SIGTERM", () => cleanup("SIGTERM"))

  console.error(`RWKV CLI | model: ${path.basename(modelPath)} | gpu: ${gpuArg} | story: ${story}`)
  if (loraPaths) console.error(`LoRA: ${loraPaths.join(", ")}`)
  if (fixParagraphs) console.error("Fix-paragraph-break enabled")
  console.error(`Session: ${sessionDir}`)
  console.error("---")

  await model.init(gpuArg, loraPaths)
  await agent.init()

  let grammar: string | undefined
  if (grammarPath) {
    grammar = await fsp.readFile(makeGrammarPath(grammarPath), "utf-8")
  }

  const genOpts: Partial<GenerateOpts> = { grammar }

  switch (command) {
    case "tell": {
      const prompt = input || "Continue the story."
      console.error(`\nPrompt: ${prompt}\n`)
      const result = await agent.continueStoryStream(prompt, (t) => process.stdout.write(t), genOpts)
      console.error(`\n---\nGenerated ${result.length} chars`)
      break
    }

    case "agent": {
      const prompt = input || "What would you like to do?"
      console.error(`\nAgent mode | max depth: ${agentDepth}\n`)
      const agentSession = new Session({ id: session.sessionIdStr, agentName: "agent" })
      const agentLoop = new AgentLoop(model, agentSession, agentDepth, {
        saveSession: () => session.saveFromSession(agentSession),
      })
      cleanupAgent = () => agentLoop.dispose()
      const result = await agentLoop.run(prompt, {
        onText: (t: string) => process.stdout.write(t),
      }, genOpts)
      console.error(`\n---\nGenerated ${result.length} chars`)
      break
    }

    case "chapter": {
      const chapterNum = parseInt(args.find((a) => a.startsWith("--num="))?.split("=")[1] || "1", 10)
      const slug = args.find((a) => a.startsWith("--slug="))?.split("=")[1] || `chapter_${String(chapterNum).padStart(3, "0")}`
      const prompt = input || `Write chapter ${chapterNum}.`
      console.error(`Chapter ${chapterNum} | slug: ${slug}\n`)
      const result = await agent.continueStoryStream(prompt, (t) => process.stdout.write(t), genOpts)
      await agent.saveChapterCheckpoint(chapterNum, slug)
      console.error(`\n---\nSaved checkpoint for chapter ${chapterNum}`)
      break
    }

    case "checkpoint": {
      const sub = args[1]
      if (sub === "save") {
        const name = args[2] || `manual_${Date.now()}`
        const info = await model.saveCheckpoint(name)
        session.registerCheckpoint(name, model.statePath(name))
        await session.save()
        console.error(`Saved checkpoint "${name}" (${info.fileSize} bytes)`)
      } else if (sub === "load") {
        const name = args[2]
        if (!name) { console.error("Usage: checkpoint load <name>"); break }
        await model.loadCheckpoint(name)
        console.error(`Loaded checkpoint "${name}"`)
      } else if (sub === "ls") {
        const sess = session.get()
        const cps = Object.entries(sess.statePaths.checkpoints)
        if (cps.length === 0) { console.error("No checkpoints"); break }
        for (const [name, fp] of cps) {
          const stat = await fsp.stat(fp).catch(() => null)
          const size = stat ? `(${(stat.size / 1024).toFixed(1)} KB)` : "(missing)"
          console.error(`  ${name} ${size}`)
        }
      } else {
        console.error("Usage: checkpoint save|load|ls [name]")
      }
      break
    }

    case "plan": {
      const prompt = input || "Create a story plan with chapters, characters, and worldbuilding."
      const planPrompt = `${prompt}\n\nWrite a detailed story plan as a structured outline:`
      console.error(`\nGenerating plan...\n`)
      const { sessionId } = await model.process()
      const result = await model.generate({
        sessionId,
        prompt: planPrompt,
        opts: { ...DEFAULT_GEN_OPTS, maxTokens: 2048, temperature: 0.9, ...genOpts },
      })
      console.log(result.text)
      await model.interrupt(sessionId)
      const planPath = path.join(sessionDir, "_plan.md")
      await fsp.mkdir(sessionDir, { recursive: true })
      await fsp.writeFile(planPath, result.text, "utf-8")
      console.error(`\nPlan saved to ${planPath}`)
      break
    }

    case "interactive": {
      console.error("\nInteractive mode. Type 'exit' to quit, 'save' to checkpoint.\n")
      while (!shutdown) {
        const prompt = await new Promise<string>((resolve) => {
          process.stdout.write("\n> ")
          let buf = ""
          const stdin = process.stdin
          stdin.resume()
          const onData = (chunk: Buffer) => {
            const text = chunk.toString()
            if (text.includes("\n")) {
              buf += text.slice(0, text.indexOf("\n"))
              stdin.pause()
              stdin.removeListener("data", onData)
              resolve(buf.trim())
            } else {
              buf += text
            }
          }
          stdin.on("data", onData)
        })

        const inp = prompt
        if (!inp || inp === "exit") break
        if (inp === "save") {
          const name = `interactive_${Date.now()}`
          const info = await model.saveCheckpoint(name)
          session.registerCheckpoint(name, model.statePath(name))
          await session.save()
          console.error(`Checkpoint saved (${info.fileSize} bytes)`)
          continue
        }

        process.stdout.write("\n")
        const result = await agent.continueStoryStream(inp, (t) => process.stdout.write(t), genOpts)
        process.stdout.write("\n")
      }
      break
    }

    case "continue": {
      const sess = session.get()
      const cpNames = Object.keys(sess.statePaths.checkpoints)
      if (cpNames.length > 0) {
        const last = cpNames[cpNames.length - 1]
        await model.loadCheckpoint(last)
        console.error(`Loaded checkpoint: ${last}`)
      } else {
        console.error("No checkpoint found, starting from baseline")
        await agent.resumeFromBaseline()
      }
      const prompt = input || "Continue the story from here."
      console.error(`\nPrompt: ${prompt}\n`)
      const result = await agent.continueStoryStream(prompt, (t) => process.stdout.write(t), genOpts)
      console.error(`\n---\nGenerated ${result.length} chars`)
      break
    }

    case "state-info": {
      try {
        const sess = session.get()
        const stateSize = model.getStateSize()
        console.error(`State size: ${stateSize} bytes (${(stateSize / 1024 / 1024).toFixed(2)} MB)`)
        console.error(`Messages: ${sess.messages.length}`)
        console.error(`Steps: ${sess.stepCount}`)
        console.error(`Status: ${sess.status}`)
        console.error(`Checkpoints: ${Object.keys(sess.statePaths.checkpoints).length}`)
      } catch (e) {
        console.error(`Error: ${e}`)
      }
      break
    }

    // ---- MoSE commands ----

    case "mose": {
      const sub = args[1]

      if (sub === "expert") {
        const subsub = args[2]

        if (subsub === "create") {
          const name = args[3]
          if (!name) { console.error("Usage: mose expert create <name> [--text=...]"); break }
          const text = args.find((a) => a.startsWith("--text="))?.split("=").slice(1).join("=")
            || input
          if (!text) { console.error("Provide expert text via --text=... or as trailing argument"); break }
          const expert = await model.mose.createExpert(name, text)
          console.error(`Expert "${name}" created (${expert.stateFile})`)
        } else if (subsub === "ls") {
          const experts = model.mose.list()
          if (experts.length === 0) { console.error("No experts"); break }
          for (const e of experts) {
            const stat = await fsp.stat(e.stateFile).catch(() => null)
            const size = stat ? `(${(stat.size / 1024).toFixed(1)} KB)` : "(missing)"
            console.error(`  ${e.name} weight=${e.weight} ${size}`)
          }
        } else if (subsub === "rm") {
          const name = args[3]
          if (!name) { console.error("Usage: mose expert rm <name>"); break }
          await model.mose.removeExpert(name)
          console.error(`Removed expert "${name}"`)
        } else {
          console.error("Usage: mose expert create|ls|rm [name]")
        }
        break
      }

      if (sub === "blend") {
        // mose blend name1=weight1 name2=weight2 ...
        const weightPairs = args.slice(2)
        if (weightPairs.length === 0) { console.error("Usage: mose blend name=weight [name=weight ...]"); break }
        const weights: Record<string, number> = {}
        for (const p of weightPairs) {
          const [name, w] = p.split("=")
          weights[name] = parseFloat(w)
        }
        await model.mose.apply(weights)
        console.error(`Blended: ${JSON.stringify(weights)}`)
        break
      }

      if (sub === "generate") {
        const prompt = input
        if (!prompt) { console.error("Usage: mose generate <prompt> [name=weight ...]"); break }
        const weightPairs = args.slice(2).filter((a) => a.includes("=") && !a.startsWith("--"))
        const weights: Record<string, number> = {}
        for (const p of weightPairs) {
          const [name, w] = p.split("=")
          weights[name] = parseFloat(w)
        }
        const { sessionId } = await model.process()
        const result = await model.generate({
          sessionId,
          prompt,
          opts: {},
          blend: Object.keys(weights).length > 0 ? weights : undefined,
        })
        await model.interrupt(sessionId)
        console.log(result.text)
        break
      }

      if (sub === "segment") {
        // Parse segment definitions (for now, 2 expert segments from CLI args)
        console.error("Segment routing: define segments in code or use the gateway API")
        console.error("  POST /mose/segment with JSON body: { segments: [{text, blend}] }")
        break
      }

      console.error(`
Usage: mose <subcommand>

Subcommands:
  expert create <name> --text="..."   Create expert state from text
  expert ls                           List experts
  expert rm <name>                    Remove expert
  blend name=weight [...]             Blend experts into sequence
  generate <prompt> [name=weight ...] Blend + generate
  segment                             Segment routing (use API)
`)
      break
    }

    // ---- MoLE commands ----

    case "lora": {
      const sub = args[1]

      if (sub === "add") {
        const name = args[2]
        const filePath = args.find((a) => a.startsWith("--file="))?.split("=").slice(1).join("=")
        const scaleRaw = args.find((a) => a.startsWith("--scale="))?.split("=")[1]
        if (!name || !filePath) { console.error("Usage: lora add <name> --file=<path> [--scale=N]"); break }
        const absPath = filePath.startsWith("/") ? filePath : path.join(PROJECT_ROOT, filePath)
        model.loraMgr.add(name, absPath, scaleRaw ? parseFloat(scaleRaw) : 1.0)
        console.error(`LoRA "${name}" registered (${absPath})`)
        break
      }

      if (sub === "rm") {
        const name = args[2]
        if (!name) { console.error("Usage: lora rm <name>"); break }
        model.loraMgr.remove(name)
        console.error(`Removed LoRA "${name}"`)
        break
      }

      if (sub === "ls") {
        const adapters = model.loraMgr.list()
        const active = model.loraMgr.getActive()
        if (adapters.length === 0) { console.error("No LoRA adapters registered"); break }
        for (const a of adapters) {
          const isActive = active.includes(a.name)
          console.error(`  ${a.name} ${isActive ? "(active)" : ""} scale=${a.scale} ${a.filePath}`)
        }
        break
      }

      if (sub === "activate") {
        const names = args.slice(2)
        if (names.length === 0) { console.error("Usage: lora activate <name> [name ...]"); break }
        await model.loraMgr.activate(...names)
        console.error(`Activated LoRA: ${names.join(", ")}`)
        break
      }

      if (sub === "deactivate") {
        await model.loraMgr.deactivateAll()
        console.error("All LoRA adapters deactivated")
        break
      }

      console.error(`
Usage: lora <subcommand>

Subcommands:
  add <name> --file=<path> [--scale=N]   Register LoRA adapter
  rm <name>                               Remove LoRA adapter
  ls                                      List registered adapters
  activate <name> [name ...]              Activate adapter(s)
  deactivate                              Deactivate all
`)
      break
    }

    default:
      console.error(`
Usage: pnpm tsx cli.ts <command> [options]

Commands:
  gateway              Start gateway (engine + API + WS broadcast)
  tui                  Terminal UI (--connect to connect to running gateway)
  tell [prompt]        Generate story text
  agent [prompt]       Agent mode with tool use
  chapter --num=N      Write a chapter, save checkpoint
  checkpoint save|load|ls
  plan [prompt]        Generate story plan
  interactive          Interactive story mode
  continue [prompt]    Continue from latest checkpoint
  state-info           Show engine/session state info
  mose                 Mixture of State Experts (see mose --help)
  lora                 LoRA expert management (see lora --help)

Options:
  --model=PATH         Model path (.st safetensors file)
  --story=NAME         Story slug
  --gpu=TYPE           GPU backend: vulkan | cuda | auto
  --lora=PATH          LoRA adapter(s)
  --depth=N            Max agent loop depth (default: 5)
  --grammar=PATH       GBNF grammar file (resolved from src/grammars/ if relative)
  --port=N             Gateway port (default: 3030)
  --host=URL           Gateway URL for --connect mode
  --connect            TUI connects to running gateway
  --no-gateway         Force direct model load (skip gateway auto-detect)
  --fix-paragraphs, -p Continue past \\n\\n EOS boundary
`)
      process.exit(1)
  }

  await agent.dispose()
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(1)
})
