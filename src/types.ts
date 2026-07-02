export interface RwkvSession {
  story: string
  model: string
  messages: RwkvMessage[]
  stepCount: number
  status: "new" | "active" | "complete" | "error"
  updatedAt?: string
  error?: string
  statePaths: {
    baseline: string
    checkpoints: Record<string, string>
    latest: string | null
  }
}

export interface RwkvMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
}

export interface StoryState {
  title: string
  synopsis: string
  tags: string[]
  currentChapter: number
  chapters: ChapterInfo[]
  planPath: string
}

export interface ChapterInfo {
  num: number
  slug: string
  title: string
  status: "draft" | "complete"
  wordCount: number
  stateCheckpoint: string | null
}

export interface GenerateOpts {
  maxTokens: number
  temperature: number
  topP: number
  repeatPenalty: number
  frequencyPenalty: number
  presencePenalty: number
  grammar?: string
}

export interface GenerateCallbacks {
  onText?: (text: string) => void
  onRawOutput?: (raw: string) => void
  onDone?: () => void
}

export const DEFAULT_GEN_OPTS: GenerateOpts = {
  maxTokens: 500,
  temperature: 0.8,
  topP: 0.9,
  repeatPenalty: 1.1,
  frequencyPenalty: 0.1,
  presencePenalty: 0,
}

export interface ToolDef {
  name: string
  description: string
  parameters: ToolParam[]
  schema?: import("zod").ZodObject<import("zod").ZodRawShape>
}

export interface ToolParam {
  name: string
  type: "string" | "number" | "boolean"
  description: string
  required: boolean
  enum?: string[]
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  name: string
  success: boolean
  data: unknown
  error?: string
}

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>

export interface SessionInfo {
  label: string
  createdAt: string
  updatedAt: string
  statePath: string
  messageCount: number
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system"
  content: string
  timestamp: string
}

// --- Model interface ---

export interface MoSEHandle {
  createExpert(name: string, text: string, weight?: number): Promise<MoSEExpert>
  list(): MoSEExpert[]
  get(name: string): MoSEExpert | undefined
  removeExpert(name: string): Promise<boolean>
  setWeight(name: string, weight: number): boolean
  setWeights(weights: MoseBlendWeights): void
  apply(weights?: MoseBlendWeights): Promise<void>
  segmentRoute(segments: { text: string; blend: MoseBlendWeights }[]): Promise<void>
  dispose(): Promise<void>
}

export interface LoRAHandle {
  add(name: string, filePath: string, scale?: number): void
  remove(name: string): boolean
  list(): { name: string; filePath: string; scale: number }[]
  getActive(): string[]
  activate(...names: string[]): Promise<void>
  deactivateAll(): Promise<void>
}

export interface Model {
  init(gpu?: string, loraPaths?: unknown): Promise<void>
  dispose(): Promise<void>
  tokenize(text: string): number[]
  detokenize(tokens: number[]): string
  generate(prompt: string, opts?: Record<string, unknown>): Promise<string>
  generateStream(prompt: string, callbacks?: GenerateCallbacks, opts?: Record<string, unknown>): Promise<string>
  evaluate(text: string): Promise<void>
  saveCheckpoint(name: string): Promise<{ filePath: string; fileSize: number }>
  loadCheckpoint(name: string): Promise<void>
  statePath(name: string): string
  bakeSystemPrompt(systemPrompt: string): Promise<{ baselinePath: string; fileSize: number }>
  loadBaseline(): Promise<void>
  getStateSize(): number
  generateWithBlend(prompt: string, blend?: MoseBlendWeights, opts?: Record<string, unknown>): Promise<string>
  generateWithSegments(segments: { text: string; blend: MoseBlendWeights }[], opts?: Record<string, unknown>): Promise<string>
  mose: MoSEHandle
  loraMgr: LoRAHandle
}

// --- MoSE types ---

export interface MoSEExpert {
  name: string
  stateFile: string
  weight: number
}

export interface MoSEConfig {
  experts: { name: string; text?: string; stateFile?: string; weight: number }[]
  /** Blend weights (expert name → weight). Applied before generation. */
  blend?: MoseBlendWeights
}

export type MoseBlendWeights = Record<string, number>

// --- MoLE types ---

export interface LoRAExpertConfig {
  name: string
  filePath: string
  scale?: number
}

export interface LoRASwitchRequest {
  adapters: string[]
}
