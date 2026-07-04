import { promises as fsp } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { Engine } from "../../types.ts"
import { Session } from "../../session/session.ts"
import { SessionManager } from "../../session/session-manager.ts"
import { AgentLoop } from "../loop.ts"
import { GenerateOpts, GenerateCallbacks } from "../../types.ts"
import { toolDefs as envoyToolDefs, toolHandlers as envoyHandlers, toolsToXml } from "./tools/index.ts"
import { toolDefs as storytellerToolDefs, toolHandlers as storytellerHandlers } from "../storyteller/tools/index.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class EnvoyAgent {
  private model: Engine

  constructor(model: Engine) {
    this.model = model
  }

  async chat(
    userInput: string,
    agentSession: Session,
    mgr: SessionManager,
    callbacks?: GenerateCallbacks,
    opts: Partial<GenerateOpts> = {},
  ): Promise<string> {
    const systemPrompt = await fsp.readFile(
      path.join(__dirname, "instructions.mdx"),
      "utf-8",
    )

    const loop = new AgentLoop(this.model, agentSession, 10, {
      systemPrompt,
      toolDefs: envoyToolDefs,
      toolHandlers: {
        ...envoyHandlers,
        spawn_agent: async (args) => {
          const agentName = args.agent as string
          const task = args.task as string
          const workspace = (args.workspace as string) || ""

          if (agentName === "storyteller") {
            const storyMgr = new SessionManager(
              mgr.sessionDirPath,
              workspace || "subtask",
              "storyteller",
            )
            await storyMgr.ensureDir()
            const storySession = new Session({ id: storyMgr.sessionIdStr, agentName: "storyteller" })

            const instructions = await fsp.readFile(
              path.join(__dirname, "..", "storyteller", "instructions.mdx"),
              "utf-8",
            )

            const subLoop = new AgentLoop(this.model, storySession, 15, {
              systemPrompt: instructions,
              toolDefs: storytellerToolDefs,
              toolHandlers: storytellerHandlers,
              saveSession: () => storyMgr.saveFromSession(storySession),
            })

            const result = await subLoop.run(task, undefined, opts)
            return { summary: result.slice(0, 500), sessionId: storySession.id }
          }

          return { summary: `Unknown agent: ${agentName}`, sessionId: "" }
        },
      },
      saveSession: () => mgr.saveFromSession(agentSession),
    })

    return loop.run(userInput, callbacks, opts)
  }
}
