# For AI Coding Agents

Native RWKV harness — napi-rs Rust binding to web-rwkv 0.10. No node-llama-cpp. Default model: `models/rwkv7-g1g-2.9b-20260526-ctx8192-converted.st`

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

Auto-connect: by default, CLI checks `http://127.0.0.1:3030/health`. If gateway running, creates `HttpModel(engineUrl)` instead of loading model directly. Saves 4GB VRAM — no reload per invocation. Use `--no-gateway` to force direct native load.

Default: `models/rwkv7-g1g-2.9b-20260526-ctx8192-converted.st`

`--gpu=vulkan|cuda|auto` passed through to web-rwkv.

## File Layout

| Path | Role |
|------|------|
| `src/cli.ts` | Entry point, arg parsing, createModel() dispatcher |
| `src/types.ts` | Shared types: Model interface, MoSEHandle, LoRAHandle, GenerateOpts, ToolDef, ToolCall |
| `src/model/native-rwkv-model.ts` | NativeRwkvModel — napi-rs wrapper. Implements Model interface. |
| `src/model/http-model.ts` | HttpModel — talks to gateway HTTP/v1 endpoints. Used by CLI when auto-connecting. |
| `src/model/mose.ts` | MoSE state blending + LoRAManager. Works with native model states. |
| `src/agent/loop.ts` | Agent loop: generate → parse tool calls → execute → feedback |
| `src/session/session.ts` | SessionManager — JSONL event log (`sessions/<id>/session.jsonl`) |
| `src/session/session-host.ts` | SessionHost — multi-session manager for gateway mode |
| `src/tools/registry.ts` | Tool defs + handlers + helpers: `toolsToXml()`, `toolsToGbnf()`, `toolsToGbnfWithThink()`, `toolsToGbnfZod()` |
| `src/tools/*.ts` | Shared tool implementations (read, write, edit, ls, mkdir, grep, find) |
| `src/tools/zod-to-gbnf.ts` | Zod→GBNF pipeline (zero deps) |
| `src/agents/storyteller/` | Story generation agent |
| `src/agents/envoy/` | User-facing agent — delegates via spawn_agent |
| `src/gateway/server.ts` | Express + WS server. REST + WS chat. v1-compat endpoints. |
| `src/grammars/` | GBNF grammar files (tool_call.gbnf, eot_tool_call.gbnf) |
| `src/web/index.html` | Browser dashboard (served by gateway) |
| `src/eval/` | Oracle mock eval + live eval |
| `native/rwkv-bindings/` | Rust napi-rs crate (web-rwkv 0.10) |
| `native/rwkv-bindings/rwkv-bindings/src/lib.rs` | Rust binding: RWSession → RwSession in JS |
| `sessions/<ts>_<id>_<slug>/` | Per-session dir: `session.jsonl`, `_state_*.state` |

## Model Interface

`src/types.ts:Model` — all backends implement this:

```
init, dispose, tokenize, detokenize,
generate, generateStream, evaluate,
saveCheckpoint, loadCheckpoint, statePath,
bakeSystemPrompt, loadBaseline, getStateSize,
generateWithBlend, generateWithSegments,
mose, loraMgr
```

## Native RWKV Binding (Rust/napi-rs)

Crate at `native/rwkv-bindings/`. Build: `cd native/rwkv-bindings/rwkv-bindings && cargo build --release`
(index.js copies .so → .node). Deps: web-rwkv (local `/tmp/web-rwkv`), napi 2, safetensors, half, memmap2.

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
- `generateStream` loads baseline before each request to prevent state accumulation across calls

## Agent Loop Protocol

Model outputs `<tool_call>\n{"name": "...", "args": {...}}\n</tool_call>`.
Agent feeds back `<tool_result>\n{...}\n</tool_result>`. Results truncated to 2000 chars.

Stop sequence: `["</tool_call>"]` cuts generation at closing tag (prevents hallucinated `<tool_result>`).
Grammar: `toolsToGbnfWithThink()` — allows think blocks, text, then single tool call.

`toolsToGbnfZod()` generates GBNF from Zod schemas on tool defs — used when grammar is available.

## Session Persistence

`SessionManager` per-run dir: `sessions/<ts>_<id>_<slug>/session.jsonl`
JSONL: init → message → checkpoint → baseline lines.
`buildPrompt()` reconstructs full prompt from stored messages + system prompt.

## Gateway API

`pnpm gateway` starts Express + WS on `0.0.0.0:3030`.

REST endpoints: `/health`, `/sessions`, `/chat`, `/mose/*`, `/lora/*`, `/v1/generate`, `/v1/stream` (SSE), `/v1/evaluate`, `/v1/state/save`, `/v1/state/load`
WS messages: `chat`, `create_session`, `switch_session`, `delete_session`
WS broadcasts: `token`, `user_message`, `done`, `session_*`

## Known Quirks

- `generateStream` is batch wrapper: full-output-then-callback on native (no streaming callback yet)
- Grammar identifiers: `[a-zA-Z][a-zA-Z0-9]*` only (no `_` or `-`)
- RWSession → RwSession in JS (napi-rs name mangling)
- MoSE/LoRA/statesave/samplers are stubs in NativeRwkvModel — implement from axum reference
- `.node` file must be manually copied from `.so` after Rust rebuild: `cp native/rwkv-bindings/rwkv-bindings/target/release/librwkv_bindings.so native/rwkv-bindings/rwkv-bindings.linux-x64-gnu.node`
- `Cargo.toml` replaced `gbnf` with `schoolmarm = "0.1.1"` for actual grammar-constrained sampling
- GBNF grammar sampling via `schoolmarm::Grammar` + `GrammarState` — `allowed_tokens()` returns bitmask per token, logits masked to `f32::NEG_INFINITY` for disallowed tokens
- Grammar set via `set_grammar()` (compiles GBNF string), each `infer()` call creates fresh `GrammarState` so every generation starts clean
- `token_strings` precomputed from `tokenizer.token_index_to_bytes()` (lossy UTF-8 conversion) — rebuilt on init
- Grammar identifier constraint `[a-zA-Z][a-zA-Z0-9]*` from schoolmarm parser — tool rules use names like `callread`, `callwrite`

## Build Notes

- **pnpm** required (v11.9.0), enforced via `devEngines` in package.json
- ESM (`"type": "module"`). Run with `tsx`. TypeScript 6.0
- `tsconfig.json`: `moduleResolution: nodenext`, `noEmit`
- Native binding: `cargo build --release` in `native/rwkv-bindings/rwkv-bindings/`
- web-rwkv at local path `/tmp/web-rwkv` (not npm/crates.io)
- `.gitignore`: `native/**/target/`, `*.node`, `models/`, `sessions/`, `*.state`

## Testing

No test runner. Only:
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm eval` — oracle mode (MockEngine, no model)
- `pnpm eval:live` — real model eval

Eval traces stored in `src/eval/.traces/` (gitignored).
