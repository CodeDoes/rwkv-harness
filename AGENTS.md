# RWKV Agent Harness

Native napi-rs Rust binding to web-rwkv 0.10. ESM (`"type": "module"`), TypeScript 6.0, `tsx` runner, **pnpm** 11.9.0 required (enforced via `devEngines`). Default model: `models/rwkv7-g1h_preview4673-2.9b-20260701-ctx8192.st` (safetensors, not GGUF).

## Commands

| `pnpm ...` | What |
|------------|------|
| `tell "prompt"` | Story generation via storyteller agent |
| `agent "prompt"` | Agent mode with tool use (`--depth=N`, default 5) |
| `chapter --num=N "prompt"` | Write chapter with state checkpoint |
| `plan "outline"` | Story plan → session dir |
| `interactive` | REPL mode |
| `continue "prompt"` | Resume from latest checkpoint |
| `checkpoint save\|load\|ls [name]` | Manual checkpoint ops |
| `state-info` | Engine/session state |
| `gateway` | Foreground Express+WS on `0.0.0.0:3030` |
| `gateway:start` | Background via `nohup` + `.gateway.pid` |
| `gateway:stop` / `:status` / `:logs` / `:tail-logs` | Daemon lifecycle |
| `tui [--connect]` | Terminal UI |
| `mose ...` / `lora ...` | MoSE / LoRA CLI |
| `eval` | Oracle mode (MockEngine, no model) — 40 checks |
| `eval:live` | Live model eval — 20 checks |
| `eval:cases` | Targeted eval — 6 scenarios |
| `test:trace` / `test:agent` / `test:format-strictness` / `test:frontmatter` / `test:vram-residency` | Per-subsystem tests |
| `test:core` | `test:state-tune && test:log-stream && test:workspace` |
| `test:grammar` | `test:grammar:valid && test:grammar:invalid && test:grammar:gen` |
| `build:native` | `cargo build --release` + copy `.so` → `.node` |
| `typecheck` | `tsc --noEmit` |
| `dev:setup` | `pnpm install && pnpm build:native` |
| `grammar:preview` | Regenerate `.preview.grammar` |

No test runner — all tests are ad-hoc `tsx` scripts that `process.exit(0|1)`.

## Architecture

| Path | Role |
|------|------|
| `src/cli.ts` | Entrypoint + `createModel()` dispatcher |
| `src/types.ts` | Shared types: `Engine`, `ToolDef`, `ToolCall`, `GenerateOpts` |
| `src/model/native-rwkv-model.ts` | `Engine` impl — napi-rs binding wrapper |
| `src/model/http-model.ts` | `Engine` impl — oRPC client to remote gateway |
| `src/model/mose.ts` | MoSE state blending + LoRAManager |
| `src/agents/loop.ts` | `AgentLoop`: generate → parse → execute → feedback |
| `src/agents/format-config.ts` | Singleton: `SEP`, `STOP_SEQ`, `TOOL_RESPONSE_PLACEMENT`, overridable via env vars |
| `src/agents/example-template.ts` | Example rendering: tags added by template, not stored in data |
| `src/agents/<name>/` | Agent packages: `envoy/`, `storyteller/`, `coder/`, `default/` |
| `src/rpc/` | oRPC contract, server (OpenAPIHandler), client (OpenAPILink) — single-sourced type-safe API |
| `src/gateway/server.ts` | Express + WS server, mounts oRPC handler at `/rpc`, old v1 endpoints for backward compat |
| `src/session/session.ts` | `Session` data class (message list) |
| `src/session/session-manager.ts` | Per-run `DirectorySessionManager` — `sessions/<ts>_<id>_<slug>/session.jsonl` |
| `src/session/session-host.ts` | Multi-session manager for gateway mode |
| `src/tools/registry.ts` | Shared tool defs + GBNF generators (`toolsToGbnf`, `toolsToGbnfWithThink`, `toolsToGbnfZod`) |
| `src/tools/utils/zod-to-gbnf.ts` | Zod→GBNF pipeline |
| `src/protocol/` | `MessagePart` type system + `ResponseTemplate` renderer |
| `src/core/state-tune-cache.ts` | SHA-256 content-hash cache for system prompt example evaluation |
| `src/core/workspace.ts` | Live (`workspace/<slug>/`) vs temp (`.tmp/workspace/`) resolution |
| `src/core/trace-writer.ts` | Streaming trace writer — `fs.writeSync` + `fs.fsyncSync` per line |
| `src/core/log-stream.ts` | Tee helper (stdout/stderr + file) |
| `src/eval/` | `EvalController`, `MockEngine`, oracle + live eval runners |
| `src/grammars/` | GBNF test files + `grammar-helpers.ts` (TS mirror of schoolmarm parser) |
| `src/inference/` | `CacheProtocol` + `LocalInferenceClient` (cache-indexed state slots) |
| `native/rwkv-bindings/` | Rust napi-rs crate. Build: `cargo build --release` in `rwkv-bindings/` |
| `native/.../index.js` | Auto-copies `.so` → `.node` |

## Engine Protocol

`src/types.ts:Engine` — the core abstraction:

```
init, dispose, tokenize, detokenize, modelInfo?,
process, generate, streamGenerate, interrupt, evaluate,
saveCheckpoint, loadCheckpoint, statePath,
bakeSystemPrompt, loadBaseline, getStateSize,
mose, loraMgr,
setStateTuneCache?, unbindFromGpu?, bindToGpu?, isGpuBound?
```

`streamGenerate(StreamGenerateRequest)` with `onToken` callback — native calls `binding.inferStream` (napi ThreadsafeFunction), HTTP proxies through oRPC `stream` event iterator.

Stop sequences (`stopTokens`) passed to Rust — checked via `output.ends_with(stop)` after each token, returns early when matched.

### Auto-connect

CLI checks `http://127.0.0.1:3030/rpc/health` (1500ms timeout). If gateway running → `HttpModel`. If not → auto-start embedded gateway + `HttpModel`. Use `--no-gateway` to force `NativeRwkvModel` direct.

### Native Binding (Rust)

- `RWSession` → `RwSession` in JS (napi-rs mangling)
- `Tokenizer::new()` takes JSON **content** string, not file path
- Default vocab: `<model_dir>/rwkv_vocab_v20230424.json`
- `quantLayers=32` hardcoded (Int8, ~4GB VRAM)
- argmax on raw logits (softmax skipped — same result for greedy)
- Prompt chunking: 128 tokens per `infer` call via `RnnInput::new(vec![batch], 128)`. Generation must wait until `num_token() == 0`
- Grammar: `schoolmarm 0.1.1`. `Grammar::parse(gbnf)` + `GrammarState::new()` + `allowed_tokens()` → bitmask, logits masked to `-inf`. Fresh `GrammarState` per `infer`/`inferStream` call. Identifier rule: `[a-zA-Z_][a-zA-Z0-9_-]*` — but tool rules strip `_` via `toolName.replace(/_/g, "")` (e.g., `story-analyze` → `callstory-analyze`)
- Post-build: `.so` → `.node` copy required (`pnpm build:native`)

## Agent Protocol

Model outputs `<tool_call>\n{"name": "...", "args"/"arguments": {...}}\n</tool_call>`. Agent feeds back `<tool_response>\n{...}\n</tool_response>`. Results truncated to 2000 chars.

Format config (`src/agents/format-config.ts`) — overridable via env vars:
- `SEP` (default `"\n\n"`), `STOP_SEQ` (default `"</tool_call>,\n\nUser:"`)
- `TOOL_RESPONSE_PLACEMENT` = `block`|`inline`, `INDENT_STYLE` = `all-indented`|`tags-flush`, `SUBAGENT_WRAP` = `xml`|`none`

Grammar: `toolsToGbnfWithThink()` (`root ::= ws? (think-block \| text \| call ws?)+`). Continuation grammar: `root ::= .*` (schoolmarm can't express `</tool_call>` as single-token in subword tokenizers).

Tool call JSON key: `"arguments"` in def-based variants, `"args"` in Zod variant.

### Validation Policy

- **Examples** = preferred style (strict: `EvalController.validateAssistantOutput` — tab-indented, no role echoes, balanced XML)
- **Grammar** = most lenient (only enforces tag structure + valid JSON in `<tool_call>`)
- **Live eval** uses lenient validator; strict warnings at runtime only
- `pnpm test:format-strictness` validates both side-by-side

### Agents

| Agent | Tools | Notes |
|-------|-------|-------|
| `envoy` | `spawn_agent` | User-facing, delegates to subagents. Depth 10. |
| `storyteller` | read, write, ls, grep, find, story-analyze, story-validate | No `mkdir` (write auto-creates dirs). Enforces `.md` + never-same-path-twice + `_plan.md`, `chapter-*`, wiki structure. |
| `coder` | read, write, edit, ls, mkdir, grep, find | Has `edit` + `mkdir`. |
| `default` | read, write, edit, ls, mkdir, grep, find | Basic examples in `examples.jsonl`. |

Write tool auto-adds `.md` if filename has no dot extension. Example tags (`<think>`, `<tool_call>`...) added by template renderer, not stored in data.

### Agent Loop

- Tracks last 8 tool call signatures; same `(name + path)` ≥3 times → skipped with error response
- Empty stream retry (3×), think-block retry (3×), continuation bailout (5 consecutive length stops)
- `model.process()` fires at init, then delta via fullPrompt only

## Testing

| Command | Description |
|---------|-------------|
| `pnpm typecheck` | Required before any commit |
| `pnpm eval` | Oracle (MockEngine, no model) — full end-to-end through embedded gateway |
| `pnpm eval:live` | Real model — 20 checks |
| `pnpm eval:cases` | 6 targeted oracle scenarios |
| `pnpm test:trace` | TraceWriter shape (21 tests) |
| `pnpm test:agent` | Agent loop (11 tests) |
| `pnpm test:format-strictness` | Validator cross-checks |
| `pnpm test:core` | State-tune + log-stream + workspace |
| `pnpm test:grammar` | Grammar valid + invalid + gen |
| `pnpm test:frontmatter` | Storyteller frontmatter parsing |
| `pnpm test:vram-residency` | GPU binding lifecycle |

Oracle eval runs through embedded GatewayServer + HttpModel to exercise full HTTP/oRPC pipeline, even without a real model. Traces at `.traces/` (gitignored), streaming `fs.fsyncSync` per line.

## Key Conventions & Gotchas

- `import` with `.ts` extension required (ESM + nodenext)
- `tsx` runner — never `ts-node`
- web-rwkv at local path `/home/kit/extern/web-rwkv` (not npm/crates.io)
- `.gitignore`: `native/**/target/`, `*.node`, `models/`, `sessions/`, `*.state`
- `bakeSystemPrompt` does **not** evaluate text — saves blank state as baseline. System text handled via session `buildPrompt()` + `loadBaseline()` per request
- `pnpm gateway:start` uses `nohup` + `.gateway.pid` — plain background process, not a daemon
- Gateway has old v1 REST endpoints for backward compat — WS broadcast logic potentially needs migration to oRPC
- `PLAN.md` and `MOSE.md` at root have implementation notes and future work — useful before major changes
- README.md is partially outdated (mentions node-llama-cpp) — AGENTS.md is the ground truth
