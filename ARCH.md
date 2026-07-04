# ADR: Architecture (decided)

## Topology

```
inference-server ←—oRPC—→ gateway ←—oRPC/HTTP/WS—→ client
   (model runner,         (orchestrator:            (chat UI, TUI,
    cacheId protocol,       sessions,                CLI commands,
    state save/load,        tool calls,              second gateway,
    message-blind)          queueing,                 remote program)
                            state-tune,
                            message-part rendering
                            + FormatConfig,
                            BNF adapter)
```

- `inference-server`: pure text continuation. Speaks `cacheId` protocol only. No messages. Model owns its own BNF (per-model). Saves/restores `rwkv-state` to disk when `cacheId` changes. Lifecycle owned by the gateway.
- `gateway`: orchestrator. Owns `FormatConfig`, message-part templates, session/message history, tool registry, agent examples, MoSE/LoRA, and the inference-server lifecycle. Hosts the agent loop.
- `client`: consumer. CLI / TUI / chat UI / another gateway / external program. Owns the gateway lifecycle (`GatewayControl.start/stop/...`) but never touches the inference server directly.

**All three layers run on the same machine by default.** The split exists to allow them not to.

## Layer contracts

### Inference server (model-runner)
```
cache.create / cache.destroy / cache.list / cache.get
cache.upload_state(cacheId, blob) / cache.download_state(cacheId) -> blob
generate({cacheId, prompt, maxTokens, temperature, topP, stopTokens?, grammar?}) -> text | stream
interrupt(cacheId) -> {stopped}
tokenize / detokenize
server.start / server.stop / server.restart / server.is_running
server.status (logs, progress)
```
- Holds one in-VRAM cache. Single cache at a time. Saving/restoring to disk is invisible to callers (just use `cacheId`).
- **Knows nothing about messages, tools, agents, or sessions.**

### Gateway (orchestrator)
Owns: session orchestration, agents, tools, message-part templates, BNF adapter, **and the inference-server lifecycle.**

```
// gateway run-control
gateway.start()   // boot inference server as child, wait for ok, then bind /rpc
gateway.stop()    // unbind /rpc, stop inference server
gateway.restart()
gateway.is_running()
gateway.status    // progress: model load %, VRAM, tokens/sec, etc.

// sessions
session.create(label) / list / switch / delete
session.input(sessionId, messagePart) -> enqueues for next-turn generation
session.fork(sessionId, atMessageIndex) -> new sessionId
session.history(sessionId) -> MessagePart[]
session.messages_stay_intact (no clear-history; branches via fork)

// tools & agents
tool.call(sessionId, toolCallPart) -> toolResponsePart
tool.register(tool: Tool)  // def + handler + input_schema + output_schema
agent.load(name) -> Agent
agent.get_state_tune_examples(name) -> MessagePart[]   // derived from docs, not auto-loaded

// engine bridge (talks to inference server via InferenceClient)
engine.cache_attach(sessionId, cacheId)  // maps session to current cacheId
engine.generate(sessionId, opts)         // pulls prompt from session + tool state
engine.stream(sessionId, opts)           // SSE/event-iterator
```

### Client
Thin. Has its own `GatewayControl` (mirror of gateway's run-control surface, but local). Never touches the inference server directly.
```
gateway.is_running()
gateway.start() / stop() / restart()   // client's own run-control
// plus the rest of the gateway's oRPC API
```
Anything TUI/CLI/chat UI does is `session.input(...)` + `gateway` oRPC calls. A second gateway is a valid client.
```

## Type hierarchy

```ts
type MessagePart =
  | { type: "system_instruction" | "user_message" | "think" | "text"; content: string }
  | { type: "tool_call";            data: { name: string; arguments: Record<string, unknown> } }
  | { type: "tool_response";        data: { name: string; success: boolean; data?: unknown; error?: string } }
```

- `content` ≠ `data`: content for prose parts (think/text/etc.), data for structured parts (tool_call/tool_response). **A7.**

```ts
interface MessagePartTemplate {
  start: string
  newline: string
  end: string
}

interface ResponseTemplate {
  system:    MessagePartTemplate
  user:      MessagePartTemplate
  assistant: MessagePartTemplate
  tool_call: MessagePartTemplate
  tool_response: MessagePartTemplate
}

function createMessagePartTemplate({ start, newline, end }) -> MessagePartTemplate
function createResponseTemplate({ system, user, assistant, tool_call, tool_response }) -> ResponseTemplate
```

- `ResponseTemplate` is generated from `FormatConfig` via a helper. `FormatConfig` (env-overridable) is still the single source of truth for SEP / STOP_SEQ / placement / indent. **A8.**

```ts
type StopReason = "stop" | "length" | "abort" | "interrupt" | "tool_call"
```

- **No** top-level `ResponseStatus`. The five-state `stopReason` is the source of truth. "complete vs incomplete" is derived in `AgentLoop` post-parse. **A15.**

## Tool

```ts
interface Tool {
  name: string
  description: string
  input_schema:  ZodSchema
  output_schema: ZodSchema
  exec(args: z.infer<input_schema>): z.infer<output_schema>
  grammar(): string   // per-tool BNF fragment
}
```

- Single `Tool` class. **A9.**
- Output schemas are validated. **A10.**
- `Tool.grammar()` is per-tool. The agent's full grammar is assembled by the BNF adapter on the engine side, from `tool.grammar()` + the think wrapper.

## Agent

```ts
interface Agent {
  name: string
  tools: Record<string, Tool>
  instructions: string
  getStateTuneExamples(): Promise<MessagePart[]>   // derived from .mdx/.jsonl at call time
  // grammar is NOT here. BNF lives on RwkvEngineAdapter.
}
```

- **A12**: all agents support at least `(system, user, think, tool_call, tool_response, text)`.
- **A13**: `state_tune_examples` is `MessagePart[]`, lazily produced via `getStateTuneExamples()` so templates can change without re-baking JSONL files at agent definition time.
- **A14**: BNF does **not** live on `Agent`. It lives on the engine adapter (`RwkvEngineAdapter` / `RwkvInferenceClientAdapter`), because it's per-model.

## Engine + Adapter

```ts
interface Engine {
  // flat (Q4-A4 / Q5-A5)
  init(gpu?, loraPaths?): Promise<void>
  dispose()
  tokenize / detokenize

  session.open(): Promise<{ sessionId: string }>
  session.close(sessionId): Promise<void>
  session.attachCache(sessionId, cacheId): Promise<void>      // server auto save/load
  session.generate(req): Promise<GenerateResult>
  session.stream(req): Promise<GenerateResult>                 // streams tokens

  interrupt(sessionId): Promise<{ stopReason: "Interrupted" }>
  evaluate(text): Promise<void>
  saveCheckpoint / loadCheckpoint / statePath / getStateSize
  bakeSystemPrompt / loadBaseline
}

interface RwkvEngineAdapter {
  buildPrompt(session: Session, responseTemplate: ResponseTemplate): string
  buildGrammar(tools: Record<string, Tool>, opts: { think: boolean; format: ResponseTemplate }): string
  parseToolCalls(text: string, tools: Record<string, Tool>, opts: ResponseTemplate): ToolCall[]
}
```

- `RwkvEngineAdapter` owns BNF construction + prompt building. Per-model. **A11.**
- This is *not* the harness's job — the harness owns state-tuning examples and message-part rendering, not raw grammar strings.

## InferenceClient + InferenceServerControl

```ts
interface InferenceClient {
  // engine contract over the wire
  cacheCreate(): Promise<{ cacheId: string }>
  cacheDestroy(cacheId): Promise<void>
  cacheList(): Promise<{ cacheId: string }[]>
  cacheGet(cacheId): Promise<{ found: boolean }>
  cacheAttachForSession(sessionId): Promise<void>   // signals which cache is "live"

  generate(req): Promise<{ text: string; stopReason: StopReason }>
  stream(req): AsyncIterable<{ token: string }>     // finishes with full result
  input(req: { cacheId: string; text: string }): Promise<void>  // interrupt + append + ready

  interrupt(): Promise<{ stopped: true }>
  tokenize / detokenize
  start / stop / restart / is_running
}

interface InferenceServerControl {
  is_running(): boolean
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  // logs are tailable by clients via `server.logs` event stream
}
```

- `input()` is *not* mid-stream. **A3.**
- **Clients never call `Engine.cache_*` directly** — only the gateway's `InferenceClient` does. Clients reach cache state indirectly via `session.attachCache(sessionId)` on the gateway. **A2.**
- Server emits progress logs; the gateway tails them and surfaces "loading model 27% / 12.4 GB VRAM / 8 tok/s" to clients. **A1.**

## Session

```ts
interface Session {
  id: string
  agent: Agent
  context: MessagePart[]            // append-only message history
  cacheId: string | null            // server-side handle; auto-synced to context size
  childSessions: Session[]          // real pointers, only valid while engine is up

  input(message: MessagePart): Promise<void>          // queues part for next turn
  resume(): Promise<GenerateResult>                   // generate until stop
  fork(atIndex: number): Promise<Session>
}
```

- The harness's session is message-only. **A16.**
- Cache lives on the inference server side (`cacheId` protocol), *but the harness tracks `cacheId` alongside `context` so they never drift.* **A17.**
- `Session.resume()` = "generate until stop." Sessions cannot clear their own history; they `fork()`. **A17.**
- `childSessions` exist but work via the **spawn_agent tool like any other tool** — they're stored as pointers in the parent, not as a special API. If the engine restarts they may be stale. **A18.**

## Gateway's mental model

```
client request
  │
  ▼
HTTP/WS handler
  │
  ▼
session.input(messagePart)           ── appends to context
  │
  ▼
engine.session.generate({           ── turns message parts into a text prompt
  sessionId,                         via RwkvEngineAdapter.buildPrompt
  grammar:                           via RwkvEngineAdapter.buildGrammar
  …
})
  │
  ▼
InferenceClient.generate / stream    ── oRPC → inference server
  │
  ▼
tokens → parse tool_calls → tool.call() → tool_response
  │                                       │
  ▼                                       │
session.input(toolResponse)  ◀─────────────┘
  │
  ▼ (loop until stop)
stream tokens to client
```

Gateway owns:
- sessions (message parts only)
- agents (tools, instructions, examples)
- FormatConfig (→ templates → prompt)
- BNF adapter (`RwkvEngineAdapter`)
- MoSE / LoRA orchestration
- filesystem/VM for tool execution ("agent manager" — third role)

Gateway does **not** own:
- model weights
- rwkv-state (lives on inference server)
- raw tokenization (delegates to inference server)

## Code-grounded layer mapping

| New concept | Today (reality) | New home |
|---|---|---|
| `Engine` | `interface Model` in `src/types.ts:159` | rename + keep flat |
| `InferenceClient` + `InferenceServerControl` | `pnpm gateway:*` CLI scripts | thin client lib + oRPC routes |
| `cacheId` protocol | `sessionId` from `Model.process()` | new oRPC procedures, RTL `Model.live` map |
| `Tool` class | `ToolDef` + `ToolHandler` split | one class |
| `Agent` | `LoadedAgent` from `agent-loader.ts` | class with `getStateTuneExamples()` |
| `MessagePart` | JSONL example entries + rendered string | first-class data type, JSONL uses it |
| `ResponseTemplate` | `format-config.ts` env-driven helpers | derived from `FormatConfig` via helper |
| `RwkvEngineAdapter` | `toolsToGbnfWithThink` + string assembly in `loop.ts` | new module |
| `Session` | three things: `SessionManager`, `SessionHost`, `Model.live` | one class, three internal pieces |

## What's NOT changing

- Two-stage eval (`oracle`, `live`) shape.
- Trace writer format.
- oRPC is canonical.
- Local-first stays the priority. The split is **future-proofing only.**
