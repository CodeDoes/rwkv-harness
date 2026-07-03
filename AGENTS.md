# For AI Coding Agents

Native RWKV harness — napi-rs Rust binding to web-rwkv 0.10. No node-llama-cpp. Default model: `models/rwkv7-g1h_preview4673-2.9b-20260701-ctx8192.st`

## Commands

| `pnpm ...` | What |
|------------|------|
| `tell "prompt"` | Generate story text (`tsx src/cli.ts tell ...`) |
| `agent "prompt"` | Agent mode with tool use (--depth=N, default 5) |
| `chapter --num=N "prompt"` | Write chapter, save checkpoint |
| `plan "outline"` | Generate story plan, save to session dir |
| `interactive` | REPL mode (exit to quit, save to checkpoint) |
| `continue "prompt"` | Resume from latest checkpoint |
| `checkpoint save\|load\|ls [name]` | Manual checkpoint ops |
| `state-info` | Show engine/session state |
| `gateway` | Start engine + HTTP/WS server (default port 3030) |
| `gateway:start` | Start gateway as background daemon |
| `gateway:stop` | Stop daemon gateway |
| `gateway:restart` | Restart daemon |
| `gateway:status` | Check if daemon running |
| `tui [--connect]` | Terminal UI (direct engine or gateway client) |
| `mose ...` | MoSE CLI |
| `lora ...` | LoRA adapter CLI |
| `eval` | Oracle-mode eval (mock engine, no model needed) |
| `eval:live` | Live eval with real model |
| `test:trace` | TraceWriter shape tests (21/21) |
| `typecheck` | `tsc --noEmit` |

## Model

Only native backend via `src/cli.ts:createModel()`:

| Mode | Model | File | Deps |
|------|-------|------|------|
| (default) | `NativeRwkvModel` — napi-rs Rust binding | `.st` (safetensors) | cargo, web-rwkv |
| `--engine-url=` | `HttpModel` — remote engine | remote | nothing local |

Auto-connect: by default, CLI checks `http://127.0.0.1:3030/rpc/health`. If gateway running, creates `HttpModel(engineUrl)` instead of loading model directly. Saves 4GB VRAM — no reload per invocation. Use `--no-gateway` to force direct native load.

Default: `models/rwkv7-g1h_preview4673-2.9b-20260701-ctx8192.st`

`--gpu=vulkan|cuda|auto` passed through to web-rwkv.

## File Layout

| Path | Role |
|------|------|
| `src/cli.ts` | Entry point, arg parsing, createModel() dispatcher |
| `src/types.ts` | Shared types: Model interface, ToolDef, ToolCall, ToolResult, GenerateOpts, StreamGenerateRequest with `onToken` callback |
| `src/model/native-rwkv-model.ts` | NativeRwkvModel — napi-rs wrapper. `inferStream` per-token callback via `onToken` |
| `src/model/http-model.ts` | HttpModel — talks to gateway oRPC endpoints. `streamGenerate` proxies per-token via event iterator |
| `src/model/mose.ts` | MoSE state blending + LoRAManager. Works with native model states. |
| `src/agents/loop.ts` | Agent loop: generate → parse tool calls → execute → feedback. Has SEP/STOP_SEQ constants for format experimentation |
| `src/session/session.ts` | SessionManager — JSONL event log (`sessions/<id>/session.jsonl`) |
| `src/session/session-host.ts` | SessionHost — multi-session manager for gateway mode |
| `src/tools/registry.ts` | Tool defs + handlers + helpers: `toolsToXml()`, `toolsToGbnf()`, `toolsToGbnfWithThink()`, `toolsToGbnfZod()` |
| `src/tools/write.ts` | Auto-adds `.md` extension if path has no file extension |
| `src/tools/*.ts` | Shared tool implementations (read, write, edit, ls, mkdir, grep, find) |
| `src/tools/zod-to-gbnf.ts` | Zod→GBNF pipeline (zero deps) |
| `src/agents/loop.ts` | Agent loop. Uses `toolsToGbnfWithThink()` grammar (root allows `(think-block? ws)? text? ws (call ws text? ws)?`) |
| `src/agents/storyteller/` | Story generation agent. No `mkdir` tool (write auto-creates dirs) |
| `src/agents/storyteller/examples/` | State-tune examples with `\x00` blank-line indicator between turns |
| `src/agents/envoy/` | User-facing agent — delegates via spawn_agent |
| `src/eval/` | Oracle mock eval + live eval |
| `src/eval/eval-controller.ts` | Runs agent hierarchy (envoy → storyteller). Traces tool responses via `onToolResult` |
| `src/eval/story-creation.eval.ts` | 27 oracle checks + 16 live checks. Includes `tool responses traced` |
| `src/eval/trace-writer.ts` | Streaming trace writer. `fs.writeSync` + `fs.fsyncSync` per line for real-time streaming |
| `src/rpc/contract.ts` | oRPC contract with all procedures. `stream` returns event iterator for per-token yield |
| `src/rpc/server.ts` | OpenAPIHandler mounted at `/rpc` |
| `src/rpc/client.ts` | OpenAPILink typed client |
| `src/gateway/server.ts` | Express + WS server. Mounts OpenAPIHandler. Serves OpenAPI spec at `/openapi.json` |
| `src/grammars/` | GBNF grammar files (tool_call.gbnf, eot_tool_call.gbnf) |
| `src/web/index.html` | Browser dashboard (served by gateway) |
| `native/rwkv-bindings/` | Rust napi-rs crate (web-rwkv 0.10) |
| `native/rwkv-bindings/rwkv-bindings/src/lib.rs` | Rust binding: RWSession → RwSession in JS. `inferStream` with per-token callback |
| `sessions/<ts>_<id>_<slug>/` | Per-session dir: `session.jsonl`, `_state_*.state` |

## Model Interface

`src/types.ts:Model` — all backends implement this:

```
init, dispose, tokenize, detokenize,
generate, streamGenerate, evaluate,
saveCheckpoint, loadCheckpoint, statePath,
bakeSystemPrompt, loadBaseline, getStateSize,
generateWithBlend, generateWithSegments,
mose, loraMgr
```

`streamGenerate` accepts `StreamGenerateRequest` with `onToken?: (token: string) => void` callback. Native model calls it per-token via `binding.inferStream`. HttpModel proxies through oRPC `stream` event iterator.

Stop sequences (`stopTokens`) are passed to the Rust binding's `inferStream`/`infer` so the model stops generating at the right point — no wasted tokens, no state corruption from hallucinated content past the stop sequence.

## Native RWKV Binding (Rust/napi-rs)

Crate at `native/rwkv-bindings/`. Build: `cd native/rwkv-bindings/rwkv-bindings && cargo build --release`
(index.js copies .so → .node). Deps: web-rwkv (local `/home/kit/extern/web-rwkv`), napi 2, safetensors, half, memmap2.

Key facts:
- `RWSession` → `RwSession` in JS (napi-rs name mangling)
- `Tokenizer::new()` takes JSON **content** string, not file path
- Default vocab: `<model_dir>/rwkv_vocab_v20230424.json`
- OOM avoidance: `quantLayers=32` hardcoded (Int8 quant on 32 layers, 4GB VRAM)
- argmax on raw logits (softmax skipped — same result for greedy)
- State maintained implicitly via `RnnInput`
- Only RWKV v7 (`ModelVersion::V7`)
- `infer()` must flush ALL prompt tokens before generation loop (fixed: prompt chunking via `RnnOption::Last` + chunk_size 128 only processes 128 tokens per `infer` call; generation must not start until `num_token() == 0`)
- `bakeSystemPrompt` should NOT evaluate text into state (saves blank state as baseline; system prompt text handled via session `buildPrompt()` + `loadBaseline()` per request)
- `streamGenerate` loads baseline before each request to prevent state accumulation across calls. Has per-token callback path (`inferStream`) and batch path (`infer`).
- RWKV vocab includes `\x00` (null byte, token ID present in vocab)

## Agent Loop Protocol

Model outputs `<tool_call>\n{"name": "...", "args": {...}}\n</tool_call>`.
Agent feeds back `<tool_response>\n{...}\n</tool_response>`. Results truncated to 2000 chars.

Stop sequence: `["</tool_call>", "\n\nUser:", "\x03"]` — configurable via `STOP_SEQ` constant in `loop.ts`.
Grammar: `toolsToGbnfWithThink()` — allows think blocks, text, then tool call with optional trailing text:
```
root ::= (think-block? ws)? text? ws (call ws text? ws)?
```

### Example / Template System (`src/agents/example-template.ts`)

Examples are stored as `examples/*.jsonl` files, one JSON object per line with semantic types (no tags in content):

| Type | Meaning | Rendered as |
|------|---------|-------------|
| `user` | User turn | `User: {content}` |
| `think` | Assistant thinking | `<think>{content}</think>` |
| `tool_call` | Tool invocation | `<tool_call>\n{content}\n</tool_call>` |
| `tool_response` | Tool result | `User:\n<tool_response>\n{content}\n</tool_response>` |
| `text` | Plain assistant output | `{content}` |

Tags (`<think>`, `<tool_call>`, `<tool_response>`) are added by the **template**, not stored in data. This means changing tag format requires only a template change, not a data migration.

**Templates** are registered formatters (`ExampleFormatter`) in a `Map<string, ExampleFormatter>`. Built-in:
- `default` — renders with `<think>`, `<tool_call>`, `User:`, `Assistant:`
- `no-think` — strips think blocks, same format otherwise

**Validation**: `EvalController.validateExampleFormat()` renders examples through the current template and validates each assistant turn against the GBNF grammar rules (paired tags, valid tool JSON, no `<` in text content). This catches drift between examples, code, and grammar. Oracle eval checks `envoy example format valid (GBNF)` and `storyteller example format valid (GBNF)`.

**Swapping**: Pass `template` param to `loadAgent(agentName, template)` or `renderExamples(agentName, template)`. Register new templates via `registerTemplate(name, fn)`.

### Format Configuration (`src/agents/loop.ts`)

Two module-level constants control the inter-turn format:

- **`SEP`** — blank-line indicator inserted between assistant output and tool response.
  Normally `"\n\n"` (blank line). Changes the prompt format:
  No SEP: `\n\nUser:\n` / `\n\nAssistant:` (blank line separators)
  With SEP: `\x00\nUser:\n` / `\x00\nAssistant:` (SEP replaces blank lines, `\x00` is in RWKV vocab)

- **`STOP_SEQ`** — generation stop sequences. First entry is primary stop.
  Default: `["</tool_call>", "\n\nUser:", "\x03"]`
  To use SEP as stop: `[SEP, "\n\nUser:", "\x03"]`

Change these constants to experiment with different formats. The grammar root allows trailing text after `call`, so SEP can appear in model output if stop sequence allows it.

### Loop Detection

Agent loop tracks the last 8 tool call signatures. For `write` calls, it tracks by path only (ignoring content). If the same (name \+ path) appears 3+ times, the call is skipped and an error tool response is injected telling the model to try a different path.

### Tool Response Tracing

`onToolResult` callbacks in `EvalController` write every tool result to the trace file (via `TraceWriter.write("tool", JSON.stringify(result))`). The trace shows:
```
tool: <tool_response>
{"name":"write","success":true,"data":{...}}
</tool_response>
```

## Session Persistence

`SessionManager` per-run dir: `sessions/<ts>_<id>_<slug>/session.jsonl`
JSONL: init → message → checkpoint → baseline lines.
`buildPrompt()` reconstructs full prompt from stored messages + system prompt.

## Gateway API

`pnpm gateway` starts Express + WS on `0.0.0.0:3030`.

REST endpoints: `/health`, `/rpc/*` (oRPC), `/openapi.json` (OpenAPI spec), `/sessions`, `/chat`, `/mose/*`, `/lora/*`, `/v1/generate`, `/v1/stream` (SSE), `/v1/evaluate`, `/v1/state/save`, `/v1/state/load`
WS messages: `chat`, `create_session`, `switch_session`, `delete_session`
WS broadcasts: `token`, `user_message`, `done`, `session_*`

## Write Tool Auto-Extension

`src/tools/write.ts` checks if the filename portion of the path includes a `.`. If not, it appends `.md` before writing. This ensures files like `wiki/character/ignis` become `wiki/character/ignis.md`.

## Storyteller Agent

`src/agents/storyteller/` — no `mkdir` tool (write auto-creates dirs). Tools: `write`, `ls`, `read`, `edit`, `grep`, `find`, `story-analyze`, `story-validate`.

Instructions enforce:
- All files must end with `.md` (write auto-adds)
- Never write to same path twice
- Complete full structure before stopping: `_plan.md` + `chapter-001.md`–`003.md` + wiki (character, location, faction)

Examples in `src/agents/storyteller/examples/*.txt` show exact workflow with `\x00` as blank-line indicator between assistant output and user tool response.

## Known Quirks

- `streamGenerate` has two paths: per-token callback (`inferStream` + `onToken`) and batch (`infer`). `HttpModel` always proxies through the event-iterator path via oRPC `stream` procedure.
- Stop sequences (`stopTokens`) are passed to the Rust binding's `infer`/`inferStream` — the Rust generation loop checks `output.ends_with(stop)` after each token and returns early when matched. This prevents wasted tokens AND state corruption from hallucinated content past the stop sequence.
- Grammar identifiers: `[a-zA-Z][a-zA-Z0-9]*` only (no `_` or `-`)
- RWSession → RwSession in JS (napi-rs name mangling)
- MoSE/LoRA/statesave/samplers are stubs in NativeRwkvModel — implement from axum reference
- `.node` file must be manually copied from `.so` after Rust rebuild: `cp native/rwkv-bindings/rwkv-bindings/target/release/librwkv_bindings.so native/rwkv-bindings/rwkv-bindings.linux-x64-gnu.node`
- `Cargo.toml` replaced `gbnf` with `schoolmarm = "0.1.1"` for actual grammar-constrained sampling
- GBNF grammar sampling via `schoolmarm::Grammar` + `GrammarState` — `allowed_tokens()` returns bitmask per token, logits masked to `f32::NEG_INFINITY` for disallowed tokens
- Grammar set via `set_grammar()` (compiles GBNF string), each `infer()` call creates fresh `GrammarState` so every generation starts clean
- `token_strings` precomputed from `tokenizer.token_index_to_bytes()` (lossy UTF-8 conversion) — rebuilt on init
- Grammar identifier constraint `[a-zA-Z][a-zA-Z0-9]*` from schoolmarm parser — tool rules use names like `callread`, `callwrite`
- RWKV tokenizer includes `\x00` (null byte) in its vocabulary — can be used as blank-line indicator or stop token
- `\x00` in JSON is `JSON.stringify`-escaped as `\u0000`, so it transmits cleanly over HTTP
- `TraceWriter` calls `fs.fsyncSync` after each write for real-time trace streaming
- Trace streaming: `onToken` writes each generated token to stdout AND appends to trace file ("assistant: " prefix on first token, raw text appended per token, `endLine()` after generation completes)

## oRPC (implemented)

[oRPC](https://orpc.dev) replaces all ad-hoc HTTP endpoints. A single `src/rpc/contract.ts` defines all procedures with Zod schemas. Server implements the contract, client gets perfect types without manual fetch wiring.

### Files

| Path | Role |
|------|------|
| `src/rpc/contract.ts` | Shared procedure defs (Zod schemas for input/output), `oc.router({...})` with `.route({ method, path })` annotations |
| `src/rpc/server.ts` | `implement(contract)` → `OpenAPIHandler` mounted in `GatewayServer` at `/rpc`. Spec at `/openapi.json` |
| `src/rpc/client.ts` | `createORPCClient(new OpenAPILink(...))` typed as `ContractRouterClient<typeof contract>` |

### Procedures

All `Model` + `SessionHost` operations are single-sourced in `contract.ts`:

| Namespace | Procedures |
|-----------|-----------|
| (root) | `process`, `generate`, `stream` (event iterator, per-token yield via `yieldToken`), `health`, `interrupt`, `evaluate`, `saveCheckpoint`, `loadCheckpoint` |
| session | `listSessions`, `createSession`, `switchSession`, `deleteSession`, `getMessages`, `chat` |
| `mose` | `createExpert`, `list`, `removeExpert`, `apply`, `segmentRoute` |
| `lora` | `add`, `list`, `remove`, `activate`, `deactivate` |

### Status

- ✅ Contract defined in `contract.ts` with `.route()` annotations
- ✅ Server router in `server.ts`, `OpenAPIHandler` mounted at `/rpc` in GatewayServer
- ✅ Typed client in `client.ts`, uses `OpenAPILink` matching `OpenAPIHandler` routes
- ✅ Oracle eval 27/27, live eval 16/16 (passes with model consistency)
- ⏳ Old ad-hoc GatewayServer endpoints still present for backward compat — can be removed once any WebSocket broadcast logic is moved to oRPC handlers

## Build Notes

- **pnpm** required (v11.9.0), enforced via `devEngines` in package.json
- ESM (`"type": "module"`). Run with `tsx`. TypeScript 6.0
- `tsconfig.json`: `moduleResolution: nodenext`, `noEmit`
- Native binding: `cargo build --release` in `native/rwkv-bindings/rwkv-bindings/`
- web-rwkv at local path `/home/kit/extern/web-rwkv` (not npm/crates.io)
- `.gitignore`: `native/**/target/`, `*.node`, `models/`, `sessions/`, `*.state`

## Testing

No test runner. Only:
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm eval` — oracle mode (MockEngine, no model), 27 checks
- `pnpm eval:live` — real model eval, 16 checks

Eval traces stored in `src/eval/.traces/` (gitignored). Streaming: each line is `fs.fsyncSync`'d immediately.

### Checks

Oracle (27): workspace dir, story dir, plan file, 3 chapters, 3 wiki dirs, 3 wiki entries, exact content match, envoy spawned, tool call count, mock consumed, format valid, grammar valid, tool responses traced.

Live (16): envoy spawned, format valid, workspace/story dir, plan file, 3 chapters, wiki character/location/faction dirs + entries, tool call count, tool format valid, tool responses traced.
