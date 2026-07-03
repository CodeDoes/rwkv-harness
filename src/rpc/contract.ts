import { oc, eventIterator } from "@orpc/contract"
import { z } from "zod"

// ── Primitives ──

const MoseBlendWeights = z.record(z.string(), z.number())

const Segment = z.object({ text: z.string(), blend: MoseBlendWeights })

const GenerateOpts = z.object({
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  repeatPenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  grammar: z.string().optional(),
  stopSequences: z.array(z.string()).optional(),
})

const GenerateResult = z.object({
  sessionId: z.string(),
  text: z.string(),
  stopReason: z.union([z.literal("stop"), z.literal("length"), z.literal("abort"), z.literal("interrupt")]),
})

const ProcessOpts = z.object({
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  append: z.object({ role: z.union([z.literal("system"), z.literal("user"), z.literal("assistant"), z.literal("tool")]), content: z.string() }).optional(),
  stateCheckpoint: z.string().optional(),
})

const SessionId = z.object({ sessionId: z.string() })
const SlotName = z.object({ slotName: z.string() })
const TextBody = z.object({ text: z.string() })
const PromptBody = z.object({ prompt: z.string() })

// MoSE
const MoSEExpert = z.object({ name: z.string(), stateFile: z.string(), weight: z.number() })
const CreateExpertInput = z.object({ name: z.string(), text: z.string(), weight: z.number().optional() })
const RemoveExpertInput = z.object({ name: z.string() })
const ApplyBlendInput = z.object({ weights: MoseBlendWeights.optional() })
const SegmentRouteInput = z.object({ segments: z.array(Segment) })

// LoRA
const LoRAAdapter = z.object({ name: z.string(), filePath: z.string(), scale: z.number() })
const AddLoraInput = z.object({ name: z.string(), filePath: z.string(), scale: z.number().optional() })
const RemoveLoraInput = z.object({ name: z.string() })
const ActivateLoraInput = z.object({ adapters: z.array(z.string()) })

// Session
const SessionInfo = z.object({ label: z.string(), createdAt: z.string(), updatedAt: z.string(), statePath: z.string(), messageCount: z.number() })
const ChatMessage = z.object({ role: z.union([z.literal("user"), z.literal("assistant"), z.literal("tool"), z.literal("system")]), content: z.string(), timestamp: z.string() })
const LabelInput = z.object({ label: z.string() })
const LabelOptional = z.object({ label: z.string().optional() })

const StateInfo = z.object({ path: z.string(), size: z.number() })
const StopReason = z.object({ stopReason: z.literal("Interrupted") })

// ── Contract ──

export const contract = oc.router({
  health: oc
    .route({ method: "GET", path: "/health" })
    .output(z.object({ status: z.literal("ok"), stateSize: z.number() })),

  modelInfo: oc
    .route({ method: "GET", path: "/model-info" })
    .output(z.object({ model: z.string(), stateSize: z.number() })),

  process: oc
    .route({ method: "POST", path: "/process" })
    .input(ProcessOpts)
    .output(SessionId),

  generate: oc
    .route({ method: "POST", path: "/generate" })
    .input(z.object({ sessionId: z.string(), prompt: z.string(), opts: GenerateOpts.optional(), blend: MoseBlendWeights.optional(), segments: z.array(Segment).optional() }))
    .output(GenerateResult),

  stream: oc
    .route({ method: "POST", path: "/stream" })
    .input(z.object({ sessionId: z.string(), prompt: z.string(), opts: GenerateOpts.optional(), blend: MoseBlendWeights.optional(), segments: z.array(Segment).optional() }))
    .output(eventIterator(z.object({ token: z.string() }), GenerateResult)),

  interrupt: oc
    .route({ method: "POST", path: "/interrupt" })
    .input(SessionId)
    .output(StopReason),

  evaluate: oc
    .route({ method: "POST", path: "/evaluate" })
    .input(TextBody)
    .output(z.void()),

  saveCheckpoint: oc
    .route({ method: "POST", path: "/save-checkpoint" })
    .input(SlotName)
    .output(StateInfo),

  loadCheckpoint: oc
    .route({ method: "POST", path: "/load-checkpoint" })
    .input(SlotName)
    .output(z.void()),

  listSessions: oc
    .route({ method: "GET", path: "/sessions" })
    .output(z.array(SessionInfo)),

  createSession: oc
    .route({ method: "POST", path: "/sessions" })
    .input(LabelInput)
    .output(SessionInfo),

  switchSession: oc
    .route({ method: "POST", path: "/sessions/switch" })
    .input(LabelInput)
    .output(SessionInfo),

  deleteSession: oc
    .route({ method: "DELETE", path: "/sessions/{label}" })
    .input(LabelInput)
    .output(z.void()),

  getMessages: oc
    .route({ method: "GET", path: "/sessions/{label}/messages" })
    .input(LabelOptional)
    .output(z.array(ChatMessage)),

  chat: oc
    .route({ method: "POST", path: "/chat" })
    .input(PromptBody)
    .output(z.string()),

  mose: {
    createExpert: oc
      .route({ method: "POST", path: "/mose/experts" })
      .input(CreateExpertInput)
      .output(MoSEExpert),

    list: oc
      .route({ method: "GET", path: "/mose/experts" })
      .output(z.array(MoSEExpert)),

    removeExpert: oc
      .route({ method: "DELETE", path: "/mose/experts/{name}" })
      .input(RemoveExpertInput)
      .output(z.boolean()),

    apply: oc
      .route({ method: "POST", path: "/mose/blend" })
      .input(ApplyBlendInput)
      .output(z.void()),

    segmentRoute: oc
      .route({ method: "POST", path: "/mose/segment" })
      .input(SegmentRouteInput)
      .output(z.void()),
  },

  lora: {
    add: oc
      .route({ method: "POST", path: "/lora/experts" })
      .input(AddLoraInput)
      .output(z.void()),

    list: oc
      .route({ method: "GET", path: "/lora/experts" })
      .output(z.object({ adapters: z.array(LoRAAdapter), active: z.array(z.string()) })),

    remove: oc
      .route({ method: "DELETE", path: "/lora/experts/{name}" })
      .input(RemoveLoraInput)
      .output(z.void()),

    activate: oc
      .route({ method: "POST", path: "/lora/activate" })
      .input(ActivateLoraInput)
      .output(z.void()),

    deactivate: oc
      .route({ method: "POST", path: "/lora/deactivate" })
      .output(z.void()),
  },
})

export type Contract = typeof contract
