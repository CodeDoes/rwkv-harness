import { implement } from "@orpc/server"
import { OpenAPIHandler } from "@orpc/openapi/node"
import { OpenAPIGenerator } from "@orpc/openapi"
import type { Model, GenerateResult } from "../types.ts"
import type { SessionHost } from "../session/session-host.ts"
import { contract } from "./contract.ts"

export interface RpcContext {
  model: Model
  host: SessionHost
}

const base = implement(contract)

function createRouter(model: Model, host: SessionHost, modelPath: string) {
  const modelName = modelPath.split("/").pop() || modelPath
  return base.router({
    health: base.health.handler(async () => {
      const stateSize = model.getStateSize()
      return { status: "ok" as const, stateSize }
    }),

    modelInfo: base.modelInfo.handler(async () => {
      const stateSize = model.getStateSize()
      return { model: modelName, stateSize }
    }),

    process: base.process.handler(async ({ input }) => {
      const { sessionId } = await model.process(input)
      return { sessionId }
    }),

    generate: base.generate.handler(async ({ input }) => {
      const { sessionId, prompt, opts, blend, segments } = input
      const result = await model.generate({ sessionId, prompt, opts, blend, segments })
      return result
    }),

    stream: base.stream.handler(async function* ({ input }) {
      const { sessionId, prompt, opts, blend, segments } = input
      const queue: string[] = []
      let resolve: (() => void) | null = null
      let done = false
      let result: GenerateResult = { sessionId: "", text: "", stopReason: "stop" }

      const genPromise = model.streamGenerate({
        sessionId, prompt, opts, blend, segments,
        onToken: (token) => {
          queue.push(token)
          resolve?.()
          resolve = null
        },
      })
      genPromise.then((r) => {
        result = r
        done = true
        resolve?.()
        resolve = null
      }).catch(() => {})

      while (!done || queue.length > 0) {
        while (queue.length > 0) {
          const token = queue.shift()!
          yield { token }
        }
        if (!done) {
          await new Promise<void>((r) => { resolve = r })
        }
      }

      return { sessionId, text: result.text, stopReason: result.stopReason }
    }),

    interrupt: base.interrupt.handler(async ({ input }) => {
      return model.interrupt(input.sessionId)
    }),

    evaluate: base.evaluate.handler(async ({ input }) => {
      await model.evaluate(input.text)
    }),

    saveCheckpoint: base.saveCheckpoint.handler(async ({ input }) => {
      const result = await model.saveCheckpoint(input.slotName)
      return { path: result.filePath, size: result.fileSize }
    }),

    loadCheckpoint: base.loadCheckpoint.handler(async ({ input }) => {
      await model.loadCheckpoint(input.slotName)
    }),

    listSessions: base.listSessions.handler(async () => {
      return host.listSessions()
    }),

    createSession: base.createSession.handler(async ({ input }) => {
      return host.createSession(input.label)
    }),

    switchSession: base.switchSession.handler(async ({ input }) => {
      return host.switchSession(input.label)
    }),

    deleteSession: base.deleteSession.handler(async ({ input }) => {
      await host.deleteSession(input.label)
    }),

    getMessages: base.getMessages.handler(async ({ input }) => {
      return host.getMessages(input.label)
    }),

    chat: base.chat.handler(async ({ input }) => {
      return host.chat(input.prompt)
    }),

    mose: {
      createExpert: base.mose.createExpert.handler(async ({ input }) => {
        return model.mose.createExpert(input.name, input.text, input.weight)
      }),

      list: base.mose.list.handler(async () => {
        return model.mose.list()
      }),

      removeExpert: base.mose.removeExpert.handler(async ({ input }) => {
        return model.mose.removeExpert(input.name)
      }),

      apply: base.mose.apply.handler(async ({ input }) => {
        await model.mose.apply(input.weights)
      }),

      segmentRoute: base.mose.segmentRoute.handler(async ({ input }) => {
        await model.mose.segmentRoute(input.segments)
      }),
    },

    lora: {
      add: base.lora.add.handler(async ({ input }) => {
        model.loraMgr.add(input.name, input.filePath, input.scale)
      }),

      list: base.lora.list.handler(async () => {
        return { adapters: model.loraMgr.list(), active: model.loraMgr.getActive() }
      }),

      remove: base.lora.remove.handler(async ({ input }) => {
        model.loraMgr.remove(input.name)
      }),

      activate: base.lora.activate.handler(async ({ input }) => {
        await model.loraMgr.activate(...input.adapters)
      }),

      deactivate: base.lora.deactivate.handler(async () => {
        await model.loraMgr.deactivateAll()
      }),
    },
  })
}

let routerInstance: ReturnType<typeof createRouter> | null = null

export function createOpenAPIHandler(model: Model, host: SessionHost, modelPath = "unknown"): OpenAPIHandler<Record<string, never>> {
  routerInstance = createRouter(model, host, modelPath)
  return new OpenAPIHandler(routerInstance)
}

export async function generateOpenAPISpec(): Promise<object> {
  if (!routerInstance) {
    return { openapi: "3.0.3", info: { title: "RWKV Gateway", version: "1.0.0" }, paths: {} }
  }
  const generator = new OpenAPIGenerator()
  return generator.generate(routerInstance, {
    info: { title: "RWKV Gateway", version: "1.0.0" },
  })
}
