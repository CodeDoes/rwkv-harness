import { implement } from "@orpc/server"
import { RPCHandler } from "@orpc/server/node"
import type { Model } from "../types.ts"
import type { SessionHost } from "../session/session-host.ts"
import { contract } from "./contract.ts"

export interface RpcContext {
  model: Model
  host: SessionHost
}

const base = implement(contract)

function createRouter(model: Model, host: SessionHost) {
  return base.router({
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
      let fullText = ""
      let stopReason: "stop" | "length" | "abort" | "interrupt" = "stop"
      await model.streamGenerate({
        sessionId, prompt, opts, blend, segments,
        onToken: (token) => {
          fullText += token
        },
      })
      yield { token: fullText }
      return { sessionId, text: fullText, stopReason }
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

export function createRpcHandler(model: Model, host: SessionHost): RPCHandler<Record<string, never>> {
  const router = createRouter(model, host)
  return new RPCHandler(router)
}
