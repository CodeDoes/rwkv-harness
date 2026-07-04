# Architecture: Reality vs Desired

A side-by-side of what the codebase does today (grounded in `src/`) versus the mental model in `TODO.md`. For each gap I either note the existing analog or flag it as a question for you.

Legend:
- ✅ **aligned** — your TODO model and the code agree on shape
- 🔁 **renamed** — same idea, different name
- 🔧 **split differently** — your model collapses two things that the code keeps separate
- ❓ **genuine gap** — your TODO model has something the code does not, or vice versa
- ⚠️ **bug-shaped assumption** — TODO assumes a behavior that doesn't match code

---

## 1. Inference engine surface

### TODO mental model
```
InferenceClient.generate / stream / stop / start / get / input / interrupt
InferenceServerControl.is_running / start / restart / stop
Engine { inference_client, inference_server_control }
```

### Reality (`native/rwkv-bindings/` + `src/model/native-rwkv-model.ts:18`)
A single Rust class RWSession (JS: `RwSession`) exposes:
```
init(path, vocab?, quantLayers=32)
tokenize / detokenize / evaluate
infer(tokens, max, temp, topP, stopTokens?) -> string
inferStream(tokens, onToken cb, ...)
setGrammar / clearGrammar (grammar-constrained sampling)
saveState / loadState / getStateSize
```
- No `cacheId` / no out-of-band `start(input)` style.
- `NativeRwkvModel` wraps one session. State lives in the binding's implicit RNN context. Checkpoints are file paths, not keyed handles.
- No subprocess / sidecar; the binding loads in-process. The "inference server control" abstraction (daemon start/stop/restart) maps to `pnpm gateway:start/stop/restart` — those are shell wrappers around `tsx src/cli.ts gateway`, **not** a member of the model API.

### Comparison
| TODO | Reality | Status |
|---|---|---|
| `InferenceClient.{generate,stream,stop,start,get,input}` | `Model.{generate, streamGenerate, interrupt, process, saveCheckpoint, loadCheckpoint}` | 🔁 renamed + reshaped |
| `InferenceServerControl.{is_running,start,stop,restart}` | shell-level `pnpm gateway:*` pnpm scripts | 🔁 renamed + lives outside the model |
| `Engine.inference_client` | `Engine` *is* the inference client (one RWKV session) | 🔧 TODO splits engine from client; code doesn't |
| `cacheId` | RNN state bound to the singleton session; persisted via file paths | ❓ design choice: is the cacheId abstraction wanted at all? |

### Questions
- **Q1.** Is the `InferenceServerControl` layer something you want to bring in? A sidecar-binary abstraction would let you swap `rwkv7` for llama.cpp without changing callers — but you'd have to decide what "start" / "stop" mean relative to `pnpm gateway`.
- **A1** I want a server controller from client side. at least for now. I also want the server's log to be more informative about what it is currently doing.
- **Q2.** Do you want a `cacheId` style abstraction? Today the binding has one implicit cache; every `Model.process()` returns a string id used only for `interrupt()`. Adding named caches would multiply VRAM cost by N — useful only if you need concurrent sessions on one process.
- **A2** no need for keeping multiple caches in the vram. only need to keep the rwkv-state in vram. ideal would be that if one cacheSession will overwrite the old rwkv-state, the rwkv-state would be saved to disk. cacheId is just a way to refer to rwkv-state that is in line with traditional transformer architecture. the thing I am making sure of with this split is that we do not take for granted that the inference is on the same machine as the harness. the inference engine might be on a different machine. it might even be a different model being served. it would be much better if we allow for the possibility of using different or stronger models in the future. While still keeping the Small local as top priority!
- **Q3.** `InferenceClient.input({cacheId, input})` — do you envision the client being able to *append* prompt tokens to an existing generation mid-stream? That is a real feature (interactive chunked input) but does not exist today.
- **A3** not mid-stream, should interrupt and then input() and then generate() again. the inference server is a "generate" it has no idea about messages and the like. It only continues the text generation. the harness is the thing applying its own message-part system on top of the inference server. 

---

## 2. Model interface

### TODO mental model
```
Model.inference_client: InferenceClient
Model.inference_server_control: InferenceServerControl
```

### Reality (`src/types.ts:159`)
```
interface Model {
  init(gpu?, loraPaths?): Promise<void>
  dispose, tokenize, detokenize
  process(opts?): { sessionId }                    // load baseline + (optional) append
  generate(req), streamGenerate(req)              // per-token onToken callback
  interrupt(sessionId)
  evaluate(text)
  saveCheckpoint, loadCheckpoint, statePath
  bakeSystemPrompt, loadBaseline, getStateSize
  mose: MoSEHandle; loraMgr: LoRAHandle
}

interface GenerateRequest {
  sessionId, prompt, opts?, signal?, blend?, segments?
}
interface StreamGenerateRequest extends GenerateRequest { onToken? }
interface GenerateResult { sessionId, text, stopReason }
```

### Status
- **aligned** for `generate / tokenize / detokenize / state save-load / interrupt`
- **🔁 renamed**: `sessionId` vs `cacheId`. Same job, different wording.
- **❓ gap**: `MoSEHandle` and `LoRAHandle` — you omitted them in TODO. They are stubs in `NativeRwkvModel` today ("from axum reference" per AGENTS.md) but they're first-class members of `Model`.

### Questions
- **Q4.** Spread the model methods into a separate `InferenceClient`? (See §1 Q1.) Or keep the flat interface?
- **A4** keep it flat.
- **Q5.** The `Model` flat surface is roughly 16 methods — is that the size you want, or would a split into `Engine` (init/state/save) + `Generator` (prompt/infer) + `MoSE` make things clearer at the call sites (CLI, TUI, gateway, eval)?
- **A5** I think it can be called Engine. I think its fine to keep it as is, as long as the file size is managable. If its too large and complex split it! Also Ignore MoSE (do not use it to guide your direction), I still haven't started using it yet.

---

## 3. Messages & response template

### TODO mental model
```ts
type MessagePart =
  | { type: "system_instruction" | "user_message" | "think" | "text"; content: string }
  | { type: "tool_call"            | "tool_response"; data: Record<string, any> }

createMessagePartTemplate({ start, newline, end }) -> MessagePartTemplate
createResponseTemplate({ system, user, assistant, tool_call, tool_response })

ResponseTemplate = {
  system, user, assistant, tool_call, tool_response  // all MessagePartTemplate
}
```

### Reality (`src/agents/example-template.ts`, `src/agents/format-config.ts`, `src/agents/loop.ts`)
- There is no `MessagePart` typed object in active use. Messages are:
  - examples in JSONL (`type: "think" | "tool_call" | "tool_response" | "user" | "text"`) — purely data, rendered by templates
  - at runtime, a flattened `string` prompt is assembled in `AgentLoop.run` (`loop.ts:121`)
- "Templates" exist in two places:
  - `format-config.ts` has *render helpers* (`formatUserRole`, `formatAssistantRole`, `renderToolResponseBlock`, etc.) — they emit strings, not MessageParts
  - `example-template.ts` registers `ExampleFormatter` funcs in a `Map<string, ExampleFormatter>` — also render-to-string
- The "createMessagePartTemplate" idea is closest to `tag(name, indentStyle)`/`indentContent(content)` (`format-config.ts:123`) plus the example formatter interface, but neither has actual `start/newline/end` configurability per role.
- Body lines are tab-indented by default (`indentStyle: "all-indented"`). Role markers are fixed at `"User:"` / `"Assistant:"`.
- Stops: `["</tool_call>", "\n\nUser:", "\x03"]`. SEP: `"\n\n"`. All overridable via env (`SEP`, `STOP_SEQ`, `TOOL_RESPONSE_PLACEMENT`, `INDENT_STYLE`).

### Status
- **❓ gap**: there is no unified `MessagePart` data structure flowing through the system. Tools' `result` values are typed (`{name, success, data, error}` — `types.ts:113`) but the *prompt representation* is just a string.
- **🔁**: `tool_response` placement is configurable (`"block"` vs. `"inline"`), and `formatToolResponseRole()` exists. Your TODO only shows `"block"`-style.

### Questions
- **Q6.** Do you want a proper `MessagePart` graph (so callers can build prompts programmatically, and serialize them to JSON for examples / state-tune / training export)? Today the data is split between JSONL examples + `FormatConfig` env vars + string assembly in `loop.ts`.
- **A6** I want to unify while keeping what we've accomplished so far. i just want to bring things closer together. i think my TODO's createResponseTemplate and createMessagePartTemplate is a better way to do it. If you do not agree explain why please. I still want the config though... maybe use my responseTemplate differently depending on the config?
- **Q7.** The `tool_call` ↔ `tool_response` symmetry is incomplete: tool calls in examples are typed-records (`type: "tool_call"` with `content: JSON.stringify({name, arguments})`), but tool calls at inference-time are parsed out of the model's text into `ToolCall` (`types.ts:108`). Do you want these unified?
- **A7** I think its better to have the content|data split. 
- **Q8.** Should the role-marker / sep / indent rules live in `MessagePartTemplate` objects per role (your TODO shape), or stay as the current `FormatConfig` global with env overrides?
- **A8** i want to use your config to generate things like the messagePartTemplate. the messagePartTemplate style is just a faster way to define rules in a neat way. i can't track so many loose functions.

---

## 4. Tools

### TODO mental model
```ts
interface Tool { input_schema: Schema; output_schema: Schema; exec(): any }
Tools: Record<string, Tool>
BnfGenerator.tool_call_schema(tool)
BnfGenerator.agent_response_schema(agent)
```

### Reality (`src/types.ts`, `src/tools/registry.ts`)
```ts
interface ToolDef {
  name, description,
  parameters: ToolParam[],          // not a Zod schema — hand-written
  schema?: ZodObject<ZodRawShape>   // optional, parallel shape
}
type ToolHandler = (args) => unknown | Promise<unknown>
type Tools = Record<string, ToolHandler>            // handlers
type ToolDefList = ToolDef[]                        // definitions (parallel)
```
- `BnfGenerator` does not exist. Equivalent free functions:
  - `toolsToXml(defs)`
  - `toolsToGbnf(defs)`
  - `toolsToGbnfWithThink(defs)`
  - `toolsToGbnfZod(defs)`
- `ToolParam` is a tiny 4-field shape, not a schema. The grammar is generated from these (`src/tools/utils/zod-to-gbnf.ts`) and via Zod-to-GBNF fallback when `schema?` is present.
- No `output_schema`. Tools may return anything; success/error is inferred.

### Status
- **🔁**: tools are split into `ToolDef` (declaration, used for grammar + UI) and `ToolHandler` (execution). Your `Tool` collapses them.
- **❓**: there is no `output_schema`. Tool responses from agents are now bare `JSON.stringify(data)` truncated to 2000 chars (`format-config.ts:111` / `renderToolResponsePayload`).
- **❓**: `BnfGenerator.tool_call_schema(tool)` ↔ `toolsToGbnfWithThink(defs)`. But you also have `agent_response_schema(agent)` — that doesn't exist as a separate function. Today the GBNF is derived purely from tool defs + the think wrapper hardcoded in `toolsToGbnfWithThink`.

### Questions
- **Q9.** Do you want a single `Tool` class encapsulating def+handler+schema+bnf-grammar-for-this-tool-only? That would let callers compose tools without touching `registry.ts`.
- **A9** yes
- **Q10.** Output schemas — any reason to type tool outputs? (Today, downstream just JSON.parse's whatever the handler returns.)
- **A10** it allows you to validate the `exec` output. you can use `schema: z.input().output()`
- **Q11.** `BnfGenerator.agent_response_schema(agent)` — do you envision per-agent grammar specialization (think blocks, multi-step planning format, etc.)? Right now grammar is identical across all agents using the same `toolDefs`.
- **A11** Yes. There might even be agent with non-message-like context-grammar... at least i think GBNF should be per model. so maybe we should attach it to something like `RwkvInferenceClientAdapter` ? 

---

## 5. Agents

### TODO mental model
```ts
interface Agent {
  tools: Tools
  instructions: string
  state_tune_examples: { [name]: MessagePart[] }
  template: ResponseTemplate
  generate_bnf(): string
}
AgentRegistry.agents: Record<string, Agent>
```

### Reality (`src/agents/agent-loader.ts:10`)
```ts
interface LoadedAgent {
  name, toolDefs, toolHandlers, instructions, examples
}
```
- No `Agent` class. Each agent is a directory `src/agents/<name>/` with `instructions.mdx`, `tools/index.ts`, `examples.jsonl` files.
- `state_tune_examples` is `examples` — a pre-rendered string, not the raw `MessagePart[]`.
- `template` lives separately (`example-template.ts`) — `registerTemplate("default", ...)`, `registerTemplate("no-think", ...)`. NOT a property of an agent.
- `generate_bnf()` is `toolsToGbnfWithThink(loaded.toolDefs)` — not a method.
- `AgentRegistry` is `loadAgent(name)` (a function returning `LoadedAgent`), not a singleton map.

### Status
- **🔧 split differently**: TODO bundles `tools + instructions + examples + template` into `Agent`. Code has `LoadedAgent` (no template) + global `TemplateRegistry` (`Map<string, ExampleFormatter>`).
- **🔁**: `state_tune_examples` ↔ `examples`. JSONL **or** rendered string? Today it's the rendered string.

### Questions
- **Q12.** Should an `Agent` actually own its template? That would let per-agent pick between `"default"` and `"no-think"` (`example-template.ts`) without global registry lookups. Cost: lose template sharing.
- **A12** im on the fence about this. you are convincing me that Agents are powerful cause they share the same message-like protocol. Im sure the basics need to be the same at least. every agent system should allow (system,user,think,tool_call,tool_response,text)
- **Q13.** Should `state_tune_examples` stay as a rendered string (current) or be retained as `MessagePart[]`? Rendering at load-time is cheaper; storing raw lets you change templates later without re-baking.
- retained as MessagePart[] please. the messageParts can be generated on start up from other documents though. i think this would be the most powerful way to do it. although this doesn't need to be something that is loaded into the agent. it can be something like getStateTuneExamples()
- **Q14.** Does `generate_bnf()` belong on `Agent` (so different agents can produce different grammars), or stay as a global derived from tool defs?
- **A14** I think its best to keep it associated with Rwkv. since this is mostly for the sake of interop with RWKV. no do not bind it with Agent. bind it with RwkvModelAdapter or RwkvInferenceClient or RwkvEngine.

---

## 6. Response completion status

### TODO mental model
```ts
type ResponseStatus = "message_incomplete" | "message_complete"
```

### Reality (`src/types.ts:88`)
```ts
type stopReason = "stop" | "length" | "abort" | "interrupt"
```
- `stop`  = matched a stop sequence (e.g. `</tool_call>`)
- `length` = hit `maxTokens` without matching a stop
- `abort` / `interrupt` = external cancellation
- There's no notion of "complete vs incomplete" — the model can stop mid-thought at any stop sequence.

### Status
- **⚠️** **bug-shaped assumption in TODO** — your enum does not match the actual `GenerateResult.stopReason`.

### Questions
- **Q15.** Do you want a higher-level `ResponseStatus` ("message_complete" = a clean parseable assistant turn that fully resolved into either text or tool-call + result; "message_incomplete" = truncated / mid-stream)? That would be derived from `stopReason` plus parser success, not a new return field.
- i think Reality is better here. maybe add a "tool_call" as a stopReason.

---

## 7. Session model

### TODO mental model
```ts
interface Session {
  agent: Agent
  cacheId: string
  context: MessagePart[]
  input(message: Message)
  resume()
  child_sessions: Session[]
  stop()
}
```

### Reality — three distinct things in the code
1. **`SessionManager`** (`src/session/session.ts:14`): per-run disk log.
   - `session.jsonl` lines: `init | message | checkpoint | baseline`.
   - Methods: `addMessage`, `buildPrompt`, `save`, `load`, `registerCheckpoint`.
   - Owns `messages: RwkvMessage[]` and `statePaths`.
   - No `agent` field, no `cacheId`, no `resume()`.
2. **`SessionHost`** (`src/session/session-host.ts`): gateway-side multi-session manager.
   - In-memory map keyed by `label`.
   - Used only in gateway mode (lines up with `EvalController` running `AgentLoop`s with separate `SessionManager`s for envoy vs. storyteller).
3. **`Model.live: Map<sessionId, {id, aborted, ancestor?}>`** in `NativeRwkvModel` (`native-rwkv-model.ts:66`): in-flight generation tracker. Keyed by id returned from `Model.process()`. Used only by `interrupt()`.

There is **no single `Session` object** that unifies all three. An `AgentLoop` holds one of each:
- a `SessionManager` (`loop.ts:77`)
- a string `sessionId` from `Model.process()` (`loop.ts:99`)
- the runtime `Model` is shared globally (not owned by session)

### Status
- **🔧 split into three**: `SessionManager` (disk log) + `SessionHost` (multi-session router) + `Model.live` (abort map). Your TODO collapses all three into `Session`.
- **🔁**: `cacheId` ↔ `Model.sessionId` from `Model.process()`. Same purpose (keying the inference state slot), different lifetime.
- **❓**: `child_sessions: Session[]` — there is no parent/child link at the session level. The parent/child relationship is held in the spawning tool call (`spawn_agent`) and the `storySession.sessionIdStr` is passed back as part of the tool result (`eval-controller.ts:129`).
- **❓**: `Session.input(message)` — closest is `SessionManager.addMessage`. But addMessage does *not* trigger another inference. The user's message goes into `buildPrompt` via the AgentLoop loop. So "input = run another turn" is encoded in `AgentLoop.run(userInput)`, not on `Session`.

### Questions
- **Q16.** Do you want a single `Session` class that wraps the RNN slot id, the JSONL log, the agent binding, and the message list? Today the wiring lives in `AgentLoop` (`loop.ts:75-99`). Centralizing it would make `Session.input()`, `Session.resume()`, `Session.child_sessions` real method calls instead of AgentLoop mechanics.
- **A16** Session is client side, and for messages only. Cache is inference side. We need something for agent side, filesystem / VM, code_execution_manager or something, session bound data.  
- **Q17.** `Session.resume()` — you might mean "reload last checkpoint from disk and continue". Today that's `agent.resumeFromBaseline()` (`cli.ts:304`) plus `model.loadCheckpoint(last)` (`cli.ts:300`), driven from the CLI, not from a Session method. Should this become a Session API?
- **A17** session is basically just message-history. if you "resume from baseline" then its similar to clearing the message-history. i'd say a session should not be able to clear its own history. or on the other hand maybe it like 1 session with multiple branches or forks. ? but main priority is keeping the cacheId in sync with the message-history. Session.resume() would be "generate until you hit a stop" 
- **Q18.** Should `Session.child_sessions` be a real parent/child pointer, or just an array of session ids that the parent can refer to? Today the link is encoded in the spawned tool's *response payload*.
- **A18** pointers. you can safely assume they are only in a valid state while the client side engine is still running. if the engine stops and restarts. the child session will not be resumable. its like a pending tool call... maybe we should not use child_sessions. maybe we should treat it like a normal tool call.

---

## 8. Gateway / RPC

Not in your TODO but tightly coupled to architecture decisions. The oRPC contract (`src/rpc/contract.ts`) defines the wire surface:
- `process`, `generate`, `stream` (event-iterator for per-token yield), `interrupt`, `evaluate`, `saveCheckpoint`, `loadCheckpoint`, `model-info`, `health`
- `session.*`: `list`, `create`, `switch`, `delete`, `chat`, `getMessages`
- `mose.*`, `lora.*`

The shape of these procedures is determined entirely by `src/types.ts:Model` operations + `SessionHost` operations. **All session/model operations are single-sourced in the contract** — there are no parallel HTTP routes for them. (The `GatewayServer` still has legacy ad-hoc routes per AGENTS.md, but those are slated for removal.)

### Questions
- **Q19.** Does your design intend the oRPC contract to be the single canonical surface, or do you want each Model method auto-exposed as a route? Today it's the former — only Model+SessionHost ops are routed. `cacheId`/`start`/`stop` would NOT be exposed because they don't exist on `Model`.
- **A19** ORPC as king for client-server interactions. no need for legacy. its not that i need full exposure. its that InferenceClient and InferenceServer overlap in many areas. also Engine it self might overlap in many areas too. 

---

## Summary of architectural decisions the TODO is forcing

Pulling out the questions that actually need an answer before this TODO can be made real:

1. **Is there one engine / one client, or one engine + control plane?** The current code is one engine + a CLI daemon wrapper. Your TODO is engine + client + control. (§1, §2)
1.1 A: ideal would have been inference-server <-> gateway-server <-> client . and then gateway managing sessions, tools calls, queueing responses, state tuning on agent example, using cacheId efficiently, calling downloadState and uploadState to the inference server.
2. **Is `MessagePart` a first-class data type, or is it just ephemeral rendering state?** It would enable JSON-serializable sessions, training data export, and template re-rendering. Today it's strings only. (§3, §7)
2.1 A: i think its the smallest and simplest part of any harness. it might be presented in a different way depending on the model but its always using those elements.
3. **Should agents own their templates and grammars, or are those global derivation functions?** Per-agent ownership is more flexible; globals are simpler. (§5)
3.1 A: ... Now I'm leaning toward the Inference Server's Model owning the template! and making the inference server talk in message parts! you are making me go back and forth.
4. **Is `Session` one thing or three?** Unifying `SessionManager + SessionHost + Model.live` under one interface would make `child_sessions / input / resume` real. It would also force a redesign of how `eval-controller.ts` orchestrates parent and child loops. (§7)
4.1 A: I think i already addressed this. To be honest I feel lost here.
5. **Are `cacheId`s wanted at all?** They enable concurrent sessions per process at N×VRAM cost. The current single-process design assumes one live session per `Model`. (§1)
5.1 A: its because the model we are using is an RNN. the closest analogy that transformers have to it is caching.
6. **Is `ResponseStatus = "complete" | "incomplete"` a meaningful higher-level signal, or just a re-derived view of `stopReason`?** If the latter, no new code is needed. (§6)
6.1 A: Already addressed above.

Once you answer those six, the comparison table above should turn into a diff.
