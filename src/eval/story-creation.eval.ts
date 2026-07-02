#!/usr/bin/env node
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { fileURLToPath } from "url"
import { EvalController, type Check } from "./eval-controller.ts"
import { loadAgent } from "../agents/agent-loader.ts"
import type { ToolDef } from "../types.ts"
import { NativeRwkvModel } from "../model/native-rwkv-model.ts"
import { TraceWriter } from "./trace-writer.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "../..")

const USER_INPUT = "Create a story about dragons with 3 first chapters and an up-to-date wiki."

function makeToolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>\n`
}

// ── Oracle content ──

const PLAN_CONTENT = `# The Dragon's Legacy\n\nA young blacksmith discovers a dying dragon and must choose between saving it and protecting his village.\n\n## Chapters\n1. The Discovery\n2. The Bond\n3. The Sacrifice\n\n## Wiki\n- Character: Lyra (dragon), Kael (blacksmith)\n- Location: Emberhold village, Dragon's Peak\n- Faction: The Ashen Council\n`
const CH1_CONTENT = `# Chapter 1: The Discovery\n\nThe forge fire hissed as Kael plunged the red-hot steel into the water. A shadow crossed the window. He looked up and saw nothing but dark trees swaying in the wind. Then he heard it: a low, rumbling moan that seemed to shake the very ground beneath his feet.\n\nHe grabbed his lantern and stepped outside. The sound grew louder, and with it came a faint orange glow from behind the ridge. Kael climbed the rocky path, his heart pounding. At the top, he froze.\n\nA massive creature lay crumpled in the ravine, its bronze scales cracked and oozing. One eye opened slowly, fixing him with a gaze that was both fierce and pleading. Kael whispered, \"You are real.\" The dragon let out a soft whimper. \"Help me,\" she breathed. \"Please.\"\n`
const CH2_CONTENT = `# Chapter 2: The Bond\n\nKael brought water from the stream. The dragon drank, her breathing steadying. He sat beside her, watching the stars emerge. \"What is your name?\" he asked. The dragon turned her head. \"Lyra,\" she said. \"I am the last of my kind. The Ashen Council hunted us down one by one.\"\n\nKael built a fire. Lyra told him of the old world, when dragons ruled the skies and humans lived in awe beneath them. \"They fear what they do not understand,\" Kael said. Lyra nodded. \"And fear makes people cruel.\"\n\nIn the days that followed, Kael tended to Lyra's wounds. She grew stronger. He climbed onto her back, and she spread her wings for the first time in months. The wind rushed past them as they soared above the village. Kael shouted with joy.\n`
const CH3_CONTENT = `# Chapter 3: The Sacrifice\n\nThe Ashen Council arrived at dawn. Three figures in gray cloaks stood at the village gate. \"We know you harbor a dragon,\" the leader said. \"Hand it over, or the village burns.\"\n\nKael stood before them. \"She is not a thing to hand over. She is my friend.\" The leader sneered. \"Then you will burn with her.\"\n\nLyra emerged from the ridge, her scales gleaming in the morning light. She spread her wings and roared. The council stumbled back. \"You wish to fight?\" Lyra said. \"I have no fight left in me. I offer myself. Let the boy go.\"\n\nThey took her away in iron chains. Kael watched until she disappeared over the horizon. That night, he found a single bronze scale lying on his doorstep. He held it tight and whispered, \"I will find you.\"\n`
const WIKI_ERYNDOR = `# Lyra\n\n**Role:** Bronze dragon, last of her kind\n**Age:** 427 years\n**Appearance:** Bronze scales, golden eyes, wingspan of 30 feet\n**Personality:** Wise, weary, fiercely protective of those she trusts\n**Backstory:** Lyra watched her entire species hunted by the Ashen Council. She fled to the mountains near Emberhold, where her injuries finally caught up with her. Kael found her and nursed her back to health, forging an unlikely bond.\n`
const WIKI_DRAGON_PEAK = `# Dragon's Peak\n\n**Location:** Mountain range east of Emberhold\n**Description:** The highest peak in the region, named for the dragons that once nested there. The summit is perpetually shrouded in mist, and the caves beneath hold ancient dragon-carved tunnels. The locals say that on quiet nights, you can still hear the echo of dragon songs.\n`
const WIKI_EMERALD_CLAW = `# The Ashen Council\n\n**Type:** Anti-dragon faction\n**Leader:** Councillor Maren\n**Headquarters:** The Ivory Tower, capital city\n**Goal:** Eliminate all remaining dragons from the realm\n**Methods:** Use of ash-magic that suppresses dragon fire. Trackers with enchanted compasses that point toward dragon blood. Bounty hunters paid per scale delivered to the council vault.\n`

// ── Oracle mode ──

async function runOracle(baseDir: string): Promise<boolean> {
  console.error("── Oracle mode (envoy → storyteller) ──")
  const storyPath = "workspace/dragons"
  const jobTask = `${USER_INPUT} Write files to ${storyPath}`

  const trace = new TraceWriter("oracle").open()
  trace.infoAbout("run", { mode: "oracle", baseDir })

  function think(content: string): string {
    return `<think>${content}</think>\n`
  }

  const mockResponses = [
    think("User wants a dragon story. Envoy delegates to storyteller.") + `I'll delegate this to the storyteller.\n` + makeToolCall("spawn_agent", { agent: "storyteller", task: jobTask, workspace: storyPath }),
    think("Check existing workspace contents before creating anything.") + `Let me check what exists first.\n` + makeToolCall("ls", { path: "workspace" }),
    think("No story dir yet. Create it.") + `Setting up story directory.\n` + makeToolCall("mkdir", { path: "workspace/dragons" }),
    think("Start with the plan file.") + `Writing plan.\n` + makeToolCall("write", { path: "workspace/dragons/_plan.md", content: PLAN_CONTENT }),
    think("Write chapter 1 with character introduction and dialogue.") + `Chapter 1.\n` + makeToolCall("write", { path: "workspace/dragons/chapter-001.md", content: CH1_CONTENT }),
    think("Write chapter 2 building on the bond between characters.") + `Chapter 2.\n` + makeToolCall("write", { path: "workspace/dragons/chapter-002.md", content: CH2_CONTENT }),
    think("Write chapter 3 with the climax and resolution.") + `Chapter 3.\n` + makeToolCall("write", { path: "workspace/dragons/chapter-003.md", content: CH3_CONTENT }),
    think("Now create wiki directories and populate them.") + `Wiki character dir.\n` + makeToolCall("mkdir", { path: "workspace/dragons/wiki/character" }),
    makeToolCall("write", { path: "workspace/dragons/wiki/character/eryndor.md", content: WIKI_ERYNDOR }),
    makeToolCall("mkdir", { path: "workspace/dragons/wiki/location" }),
    makeToolCall("write", { path: "workspace/dragons/wiki/location/dragon-peak.md", content: WIKI_DRAGON_PEAK }),
    makeToolCall("mkdir", { path: "workspace/dragons/wiki/faction" }),
    makeToolCall("write", { path: "workspace/dragons/wiki/faction/emerald-claw.md", content: WIKI_EMERALD_CLAW }),
    `Done! All chapters and wiki entries created.\n\nUser:`,
    `Created _plan.md, chapter-001.md, chapter-002.md, chapter-003.md, wiki/character/eryndor.md, wiki/location/dragon-peak.md, wiki/faction/emerald-claw.md\n\nUser:`,
  ]

  const model = EvalController.createMockModel(mockResponses)
  const envoy = await loadAgent("envoy")
  const storyteller = await loadAgent("storyteller")

  const controller = new EvalController({
    baseDir,
    model,
    sessionId: "envoy-dragons-oracle",
    trace,
  })

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const result = await controller.runAgentHierarchy({
    envoy,
    storyteller,
    userInput: USER_INPUT,
    onSpawnResult: () => ({
      filesCreated: [
        "workspace/dragons/_plan.md",
        "workspace/dragons/chapter-001.md",
        "workspace/dragons/chapter-002.md",
        "workspace/dragons/chapter-003.md",
        "workspace/dragons/wiki/character/eryndor.md",
        "workspace/dragons/wiki/location/dragon-peak.md",
        "workspace/dragons/wiki/faction/emerald-claw.md",
      ],
    }),
  })

  console.error(`\nEnvoy tool calls: 1 (spawn_agent)`)
  console.error(`Storyteller tool calls: ${result.subToolCalls}`)

  const envoyToolErr = EvalController.validateToolCallFormat(mockResponses[0], envoy.toolDefs)
  const stToolDefs: ToolDef[] = storyteller.toolDefs
  const stErrors: string[] = []
  for (let i = 1; i <= 12; i++) stErrors.push(...EvalController.validateToolCallFormat(mockResponses[i], stToolDefs))

  const envoyGrammarErr = await EvalController.validateToolGrammar(envoy.toolDefs)
  const stGrammarErr = await EvalController.validateToolGrammar(stToolDefs)

  const checks: Check[] = [
    { name: "workspace dir", pass: fs.existsSync("workspace") && fs.statSync("workspace").isDirectory() },
    { name: "story dir", pass: fs.existsSync("workspace/dragons") },
    { name: "plan file", pass: fs.existsSync("workspace/dragons/_plan.md") },
    { name: "chapter 1", pass: fs.existsSync("workspace/dragons/chapter-001.md") },
    { name: "chapter 2", pass: fs.existsSync("workspace/dragons/chapter-002.md") },
    { name: "chapter 3", pass: fs.existsSync("workspace/dragons/chapter-003.md") },
    { name: "wiki character dir", pass: fs.existsSync("workspace/dragons/wiki/character") },
    { name: "character entry", pass: fs.existsSync("workspace/dragons/wiki/character/eryndor.md") },
    { name: "wiki location dir", pass: fs.existsSync("workspace/dragons/wiki/location") },
    { name: "location entry", pass: fs.existsSync("workspace/dragons/wiki/location/dragon-peak.md") },
    { name: "wiki faction dir", pass: fs.existsSync("workspace/dragons/wiki/faction") },
    { name: "faction entry", pass: fs.existsSync("workspace/dragons/wiki/faction/emerald-claw.md") },
    { name: "plan content correct", pass: fs.readFileSync("workspace/dragons/_plan.md", "utf-8") === PLAN_CONTENT },
    { name: "ch1 content correct", pass: fs.readFileSync("workspace/dragons/chapter-001.md", "utf-8") === CH1_CONTENT },
    { name: "ch2 content correct", pass: fs.readFileSync("workspace/dragons/chapter-002.md", "utf-8") === CH2_CONTENT },
    { name: "ch3 content correct", pass: fs.readFileSync("workspace/dragons/chapter-003.md", "utf-8") === CH3_CONTENT },
    { name: "wiki eryndor correct", pass: fs.readFileSync("workspace/dragons/wiki/character/eryndor.md", "utf-8") === WIKI_ERYNDOR },
    { name: "wiki dragon-peak correct", pass: fs.readFileSync("workspace/dragons/wiki/location/dragon-peak.md", "utf-8") === WIKI_DRAGON_PEAK },
    { name: "wiki emerald-claw correct", pass: fs.readFileSync("workspace/dragons/wiki/faction/emerald-claw.md", "utf-8") === WIKI_EMERALD_CLAW },
    { name: "envoy spawned agent", pass: result.subToolCalls >= 1 },
    { name: "storyteller made all 12 tool calls", pass: result.subToolCalls === 12 },
    { name: "all mock responses consumed", pass: model.callCount === mockResponses.length },
    { name: "envoy tool call format valid", pass: envoyToolErr.length === 0 },
    { name: "storyteller tool calls format valid", pass: stErrors.length === 0 },
    { name: "envoy grammar valid", pass: envoyGrammarErr === null },
    { name: "storyteller grammar valid", pass: stGrammarErr === null },
  ]

  const allPass = EvalController.reportVerification("Oracle Verification", checks, trace)
  trace.close()
  console.error(`\nTrace: ${trace.path}`)
  process.chdir(originalCwd)
  return allPass
}

// ── Live mode ──

async function runLive(baseDir: string, args: string[]): Promise<boolean> {
  console.error("── Live mode (envoy → storyteller) ──")

  const modelPath = EvalController.resolveModelPath(args)
  const gpu = EvalController.resolveGpu(args)

  console.error(`Model: ${path.basename(modelPath)}`)
  console.error(`GPU: ${gpu}`)
  console.error(`Workspace: ${baseDir}`)

  const model = new NativeRwkvModel(modelPath, baseDir)
  await model.init(gpu)

  const originalCwd = process.cwd()
  process.chdir(baseDir)

  const trace = new TraceWriter("live").open()
  const infoData: Record<string, string> = { model: path.basename(modelPath), gpu, workspace: baseDir }
  infoData.mose = "none"
  trace.infoAbout("run", infoData)

  const envoy = await loadAgent("envoy")
  const storyteller = await loadAgent("storyteller")

  const controller = new EvalController({
    baseDir,
    model,
    sessionId: "envoy-dragons-live",
    trace,
  })

  const result = await controller.runAgentHierarchy({
    envoy,
    storyteller,
    userInput: USER_INPUT,
  })

  const storyDir = result.storyDir ? path.join(baseDir, "workspace", result.storyDir) : null
  const checks: Check[] = [
    { name: "workspace dir exists", pass: fs.existsSync(baseDir) },
    { name: "story dir found", pass: result.storyDir !== null },
    { name: "plan file exists (_plan.md)", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "_plan.md")) },
    { name: "at least 1 chapter", pass: controller.countChapterFiles(storyDir) >= 1 },
    { name: "at least 3 chapters", pass: controller.countChapterFiles(storyDir) >= 3 },
    { name: "wiki character dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "character")) },
    { name: ">=1 character entry", pass: controller.countFilesInDir(storyDir, "wiki", "character") >= 1 },
    { name: "wiki location dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "location")) },
    { name: ">=1 location entry", pass: controller.countFilesInDir(storyDir, "wiki", "location") >= 1 },
    { name: "wiki faction dir", pass: storyDir !== null && fs.existsSync(path.join(storyDir, "wiki", "faction")) },
    { name: ">=1 faction entry", pass: controller.countFilesInDir(storyDir, "wiki", "faction") >= 1 },
    { name: "envoy spawned agent", pass: result.subToolCalls >= 1 },
    { name: "at least 1 tool call", pass: result.subToolCalls > 0 },
    { name: "envoy tool call format valid", pass: EvalController.validateToolCallFormat(result.finalText, envoy.toolDefs).length === 0 },
    { name: "storyteller tool call format valid", pass: EvalController.validateToolCallFormat(result.storytellerOutput, storyteller.toolDefs).length === 0 },
  ]

  const allPass = EvalController.reportVerification("Live Verification", checks, trace)

  if (result.storyDir) {
    console.error(`\nStory files:`)
    controller.printTree(storyDir!)
  }

  trace.close()
  console.error(`\nTrace: ${trace.path}`)
  process.chdir(originalCwd)
  await model.dispose()
  return allPass
}

// ── Main ──

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const isLive = args.includes("--live")
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-story-"))
  console.error(`Base dir: ${tmpDir}`)

  let success: boolean
  if (isLive) {
    try {
      success = await runLive(tmpDir, args)
    } catch (err) {
      console.error(`Live mode error: ${err instanceof Error ? err.message : String(err)}`)
      success = false
    }
    console.error(`\nFiles preserved: ${tmpDir}`)
  } else {
    success = await runOracle(tmpDir)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    console.error(`Cleaned up: ${tmpDir}`)
  }

  console.log(success ? "EVAL PASSED" : "EVAL FAILED")
  return success ? 0 : 1
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("Eval error:", err)
  process.exit(1)
})
