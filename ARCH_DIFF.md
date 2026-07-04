# Migration plan (Reality → Architecture)

Ordered in dependency order — bottom layers first. Each step leaves the repo in a working state (`pnpm typecheck`, `pnpm eval` 27/27, `pnpm eval:live` ≥16/16 if the live model holds together).

Phases:
1. **Pin the wire protocol** — code that doesn't depend on the wire can move freely.
2. **Refactor data types** — `MessagePart`, `Tool`, `Agent`, `Session`. Pure data, low risk.
3. **Engine split** — `Engine` extracted; `RwkvEngineAdapter` introduced.
4. **InferenceClient/Control + oRPC** — new routes, new client.
5. **Agent / session unification** — `Session` becomes one thing.
6. **Gateway hosts the orchestration.**

---

## Phase 1 — Wire protocol

New file: `src/protocol/types.ts` — shared between gateway, inference server, client.

```ts
// Message parts — the canonical interchange format for prompt-related data.
export type MessagePart =
  | { type: "system_instruction" | "user_message" | "think" | "text"; content: string }
  | { type: "tool_call";    data: { name: string; arguments: Record<string, unknown> } }
  | { type: "tool_response"; data: { name: string; success: boolean; data?: unknown; error?: string } }
```

New file: `src/protocol/cache.ts` — `cacheId` protocol constants + Zod schemas.

```ts
export const CacheProtocol = {
  CREATE:   "cache.create",
  DESTROY:  "cache.destroy",
  LIST:     "cache.list",
  GET:      "cache.get",
  INPUT:    "cache.input",
  GENERATE: "cache.generate",
  STREAM:   "cache.stream",
  INTERRUPT:"cache.interrupt",
} as const
```

This is just data — no behavior changes yet. `pnpm typecheck`, `pnpm eval` should still pass.

## Phase 2 — Data-type refactor

### Task 2.1 — MessagePart
- New file `src/types/message-part.ts`. Re-export from `src/types.ts`.
- `example-template.ts`: `ExampleEntry` becomes a discriminated union of `MessagePart`.
- `SessionManager.addMessage(msg)` gains `msg: MessagePart`. Internally stores JSONL by `msg.type`.
- `SessionManager.buildPrompt` is **delegated** to `Engine.buildPrompt` (Phase 3). For now, build with `FormatConfig`.

### Task 2.2 — Tool class
- New file `src/tools/tool.ts`. Single class with `input_schema`, `output_schema`, `grammar()`, `exec()`.
- Re-export Zod-based helpers from `registry.ts`. The legacy module-level `toolDefs` / `toolHandlers` arrays become `Tool` instances.
- `src/agents/storyteller/tools/index.ts` and `src/agents/envoy/tools/index.ts` switch to `Tool`.

### Task 2.3 — Agent class
- `src/agents/agent.ts` — class text. Constructor takes name, instructions, tools, an `examples-source` (path to .mdx or .jsonl). `getStateTuneExamples(): Promise<MessagePart[]>` lazy-renders.
- `agent-loader.ts` keeps returning `LoadedAgent` for back-compat (one method call) but internally constructs `Agent`.

### Task 2.4 — Session class
- New file `src/session/session.ts` (move current file → `src/session/session-manager.ts`).
- `Session` has `id`, `agent`, `context: MessagePart[]`, `cacheId: string | null`, `childSessions: Session[]`. Methods `input`, `resume`, `fork`.
- `SessionManager` becomes a thin JSONL wrapper that *serializes* a `Session` and loads it back.

### Tests
- `pnpm typecheck` passes.
- `pnpm eval` still 27/27 — the controller still uses `SessionManager` + `AgentLoop`; nothing about the orchestrator changes until Phase 5.

## Phase 3 — Engine + Adapter

### Task 3.1 — Engine interface rename
- `src/types.ts`: `interface Model` → `interface Engine` everywhere it's imported. Mechanical grep-and-rename.
- `NativeRwkvModel` → `NativeRwkvEngine`. `HttpModel` → `HttpEngine`. CLI + eval imports updated.

### Task 3.2 — RwkvEngineAdapter
- New file `src/engines/rwkv/adapter.ts`. Class.
  - `buildPrompt(session, template)` — replaces `loop.ts:121` string assembly.
  - `buildGrammar(tools, opts)` — replaces `toolsToGbnfWithThink(...)` call site in `AgentLoop`.
  - `parseToolCalls(text, tools)` — extracts from `loop.ts:233`.
- Constructor takes the per-model details (`promptToken` cache, indent rule knowledge for RWKV).
- Exposed via `Engine.adapter` (or as a static passed to `AgentLoop`).

### Task 3.3 — AgentLoop becomes model-agnostic
- `loop.ts` no longer calls `toolsToGbnfWithThink` directly. Calls `engine.adapter.buildGrammar(...)`.
- `loop.ts` no longer calls `getFormatConfig()`. It asks `engine.adapter` for a `ResponseTemplate`, derived from the FormatConfig that lives engine-side (so the same template is used for prompt building + BNF alignment).

### Task 3.4 — `FormatConfig` is engine-owned
- The env-overridable `FormatConfig` (`src/agents/format-config.ts`) moves to `src/engines/rwkv/format-config.ts` since it's RWKV-specific formatting.
- `ResponseTemplate` (`createMessagePartTemplate` + `createResponseTemplate`) is built by `RwkvEngineAdapter.fromConfig(cfg)`.

### Tests
- `pnpm typecheck` passes.
- `pnpm eval` 27/27. Live may flicker — `RwkvEngineAdapter` is a no-op refactor of moved code.

## Phase 4 — InferenceClient + Control

### Task 4.1 — oRPC routes for the inference server
- `src/rpc/contract.ts` gains:
  ```
  cache.create / cache.destroy / cache.list / cache.get
  cache.attacheForSession(sessionId)
  cache.input({cacheId, text})
  cache.generate({cacheId, prompt, maxTokens, temperature, topP, stopTokens?, grammar?})
  cache.stream(eventIterator)
  cache.interrupt({cacheId})
  server.start / server.stop / server.restart / server.status / server.logs
  ```
- Routes `cache.*` are served by the **inference server process**, not the gateway. Gateway exposes them as proxies to whatever `engineUrl` it was constructed with — or when running in single-process mode, they're in-process.

### Task 4.2 — InferenceClient
- New file `src/inference/client.ts`. Class wraps the oRPC client.
- Two impls: `HttpInferenceClient` (HTTP) and `InProcessInferenceClient` (in single-process mode, just calls the binding directly).
- `HttpModel` becomes "an HttpClient speaking the inference protocol." Gateway gets one of these; nothing else.

### Task 4.3 — InferenceServerControl
- Implemented by `tsx src/cli.ts inference-server start` as a detached process.
- **Lifecycle owned by the gateway, not by clients** — see Phase 6.1.
- Server emits progress logs over the `server.logs` event route (event iterator @ oRPC).
- The gateway surfaces these logs to clients; CLI/TUI status bar shows "Loading model 27% / 12.4 GB VRAM / 8 tokens/sec".

### Task 4.4 — Schema cleanup
- Remove legacy ad-hoc routes from `GatewayServer` (`/v1/stream`, `/chat`, etc. — listed in AGENTS.md as slated for removal).
- The remaining routes are just the oRPC handler at `/rpc/*`.

### Tests
- `pnpm typecheck` passes.
- `pnpm eval` 27/27 unchanged.
- `pnpm eval:live` ≥16/16 against an in-process runtime (the gateway still bundles the engine).
- New manual test: `pnpm inference-server start`, `pnpm gateway --engine-url=...`. Verify `pnpm eval:live` passes.

## Phase 5 — Agent / Session unification

### Task 5.1 — Session wraps the agent binding
- `AgentLoop` no longer holds `sessionManager: SessionManager`, `session: SessionHost` (was never actually held), or the live session-id string from `Engine.process()`. It holds `Session`.
- Move logic: `eval-controller.ts:75-99` (envoy & storyteller AgentLoop construction) becomes simpler.

### Task 5.2 — Session.input → inference
- `session.input(part)` enqueues a `MessagePart`.
- `session.resume()` triggers an inference turn: asks the engine's adapter to build a prompt from `session.context`, calls `engine.stream(...)`, parses tokens, extracts tool calls, dispatches `tool.call(name, args)`, captures `tool_response`, calls `session.input(tool_response)`. Loops until `stopReason` is one of `stop | length | tool_call` (the last in the new enum).
- This is what `loop.ts` does today — it just moves onto `Session`.

### Task 5.3 — `spawn_agent` is synchronous, no child-session pointers
- `spawn_agent(agentName, task, workspace)` is a `Tool` provided by the gateway to the envoy agent. It is **synchronous**: the parent blocks until the child finishes.
- It creates a new `Session` whose `agent` is the named agent (`storyteller`), runs `session.resume()` on it until completion, and returns a `tool_response` whose `data` is the child's **last `text` `MessagePart`** (i.e. the assistant's final prose turn).
- No `childSessions` array on the parent. The parent does not store the child's `sessionId`. There is exactly **one** live session at a time — concurrency across agents is not supported yet.
- No resumption support. If the engine dies mid-tool-call, the parent's `spawn_agent` tool fails and the parent surfaces the error; it does not try to restore the child.

### Tests
- `pnpm typecheck` passes.
- `pnpm eval` 27/27.
- `pnpm eval:live` ≥16/16.

## Phase 6 — TUI/CLI simplification

### Task 6.1 — CLI/TUI become clients; gateway owns inference-server lifecycle; client owns gateway lifecycle
- The **client** never loads the model and never starts the inference server. Its only control-plane concern is the gateway.
- Add `GatewayControl` (`start`, `stop`, `restart`, `is_running`, progress-event stream) on the client side. Same API as today's `pnpm gateway:*` but exposed as a JS class so the TUI/CLI can drive it programmatically.
- The **gateway** owns the inference-server lifecycle:
  - On startup, `gateway.start()` launches the inference server (`tsx src/cli.ts inference-server start`) as a child process, waits for `server.status === "ok"`, then binds its oRPC routes.
  - On shutdown, gateway tears down oRPC first, then stops the inference server.
  - If the inference server dies mid-session, gateway surfaces the failure to active clients via its oRPC events (and probably to logs).
- Local-only: `pnpm tsx cli.ts gateway` is the single entry point. The whole stack ends up under one process supervisor, but the gateway still talks to the inference server over oRPC (so swapping it for a remote instance is one config flag — `--inference-url=`).
- CLI/TUI expressions:
  - `pnpm tsx cli.ts tui --gateway-control=auto` — starts gateway if not running.
  - `pnpm tsx cli.ts tui --gateway-control=attached` — attach to an already-running gateway.
  - `pnpm tsx cli.ts tui --gateway-url=` — pure client mode, gateway must already be running.

### Task 6.2 — TUI talks to gateway
- TUI never loads the model directly. Always gateway-client mode (`--connect` becomes the default).
- Drops the "direct engine" mode entirely.

---

## Risks & open questions

- **Phase 4.3** server-logs streaming: not currently implemented. Pick between oRPC event iterator (RESTful, but kills RTM-style log streaming when gateway restarts) or split out a WS-only connection. Suggest event iterator since it unifies with `cache.stream`.
- **Phase 5.3** child session resumption across engine restart: best-effort. Need a contract — does the gateway persist `childSessions` in `SessionManager`, and on engine restart re-issue `cache.input(...)` from checkpoints?
- **Phase 1.0** export of `MessagePart` for training data: out of scope for this migration but flagged for follow-up.
