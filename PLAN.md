# USER

Notes/brain-dump — contact that the proceedurally modeled into a PLAN below.

- trace-writer should be part of core, not just eval.
- console log streaming
- log file streaming
- logs
  - inference logs
  - gateway logs
  - eval logs

- WORKSPACE
  - temp workspace
  - live workspace

- EVAL
  - Oracle
    - Should run through real gateway with intercepted output and tool response
  - Test for common things seperately too
    - Write a chapter called X about Y
    - Write a wiki about X from chapter Y
    - Write wiki for all characters in chapter X
    - What happened in this chapter?
    - Do you see any problems with this chapter?
    - evaluate how complete _plan.md is.
- Note about how strict i need the grammar to be
  - Examples show "prefered" the output format
  - Grammar shows the most "leaniant" valid format
  - grammar enforce block level indented newlines
  - grammar only needs to <think> <tool_call> anywhere in the message and json is valid.

- Eval potentially can be (Client + Gateway in one) or can be EvalGateway

- storyteller examples
  - you need a think block in frontmatter format on the md example files
    - basically more target think blocks about the story itself.

- State tuning from examples should not need to reprocess if hash still matches

- Should not keep the model in vram memory all the time if not in use (keep in normal RAM)

# PLAN

## A. move `src/eval/trace-writer.ts` into core → `src/core/trace-writer.ts`
- Currently lives under `src/eval/` and gates on `TRACES_DIR = src/eval/.traces`. Promote to core. Re-export from `src/eval/trace-writer.ts` for back-compat.
- New home allows `pnpm eval`, `pnpm story` (CLI), and eval/test runners to all log to the same `.traces/` root.
- Keep `TraceWriter` API stable: `open`, `write`, `beginLine`, `append`, `endLine`, `separator`, `raw`, `verification`, `close`.

### Sub-tasks
- A1. Move file, update `TRACES_DIR` to repo-root `.traces/`.
- A2. Add re-export shim: `export * from "../core/trace-writer.ts"` at `src/eval/trace-writer.ts`.
- A3. Update `.gitignore` entry from `src/eval/.traces/` → `.traces/`.
- A4. Make the writer take an optional `path` argument so callers can choose location (default `.traces/<ts>_<mode>.txt`).

## B. console log streaming + log-file streaming
- The trace writer already calls `fs.fsyncSync` per token. Add a `LogStream` that pipes:
  - stdout → trace file
  - stderr → trace file
  - optionally, tee to a second sink (e.g. a web-socket during dev).
- Wire `LogStream` through:
  - `pnpm inference:start` (inference logs)
  - `pnpm gateway:start`   (gateway logs)
  - `pnpm eval`            (eval logs)
- Behavior: live tail-able via `pnpm {inference,gateway,eval}:logs` (already exists for `inference:`/`gateway:`) — add `eval:logs` and a `eval:tail-logs` for parity.

### Sub-tasks
- B1. `src/core/log-stream.ts` — wraps a `WriteStream` and `process.stdout|stderr`, forwards writes, supports `stop()`.
- B2. Hook `LogStream` into `cli.ts` `runGateway` and `runCli` (mediated through a `--log-file=...` arg).
- B3. Add `eval:logs` and `eval:tail-logs` to `package.json` (sourcing `.eval.log` written by `pnpm eval`).

## C. workspace — temp vs live
- Today: workspace dirname is hard-coded in agent loops, eval, and CLI.
- Want two modes:
  - **temp**: every session gets a unique worker dir under `.tmp/workspace/<ts>_<id>/` (default for `pnpm eval` and `pnpm tell --ephemeral`). Auto-cleaned.
  - **live**: writes go under `<cwd>/workspace/<slug>/` so the user can review the actual files afterward (default for `pnpm chapter`, `pnpm plan`).
- Implementation:
  - `src/core/workspace.ts` exports `resolveWorkspace({ mode: 'live' | 'temp', slug })` returning an absolute path and creating the directory.
  - `EvalController` calls `resolveWorkspace({ mode: 'temp', slug })` and passes it through; CLI passes a `--workspace=live` flag or picks `temp` for `--ephemeral`.
  - The socket-side path on the gateway uses a path-segment sanitizer (`@filepath.txt` style) so we never write outside the resolved root.

### Sub-tasks
- C1. `src/core/workspace.ts` + tests.
- C2. CLI argparse: `--workspace=live|temp`.
- C3. Eval defaults to `temp`.
- C4. Document in `AGENTS.md`.

## D. EVAL — overhaul

### D.i Oracle runs through a real gateway with intercepted output and tool responses
- Currently oracle uses `MockModel` and never goes through web-rwkv. Replace with an **EvalGateway** that:
  - Spawns the gateway processes OR runs an HTTP model and intercepts the model layer.
  - Has a "transcript" mode: feeds a fixed list of mock replies *to the gateway* via the `/rpc/inject` admin endpoint (add), then asserts on the resulting state.
- Two architectural variants:
  1. **Client+Gateway in one**: a test bin that imports `GatewayServer`, hooks an `EvalGate` between `Engine` and the wire, and runs eval in-process. Same `EvalController` semantics.
  2. **EvalGateway**: a separate process (`pnpm eval-gateway`) that listens on 3130 and is the target of `pnpm eval:live --gateway=3130`.

### D.ii Targeted tests for common things
Standalone evals (each becomes a jsonl fixture that lives in `src/eval/cases/`):
- "Write a chapter called X about Y" → expects exactly one `write` to `chapter-XXX.md` and the body matches `Y`.
- "Write a wiki about X from chapter Y" → expects a `read` of chapter Y, then writes a `wiki/<category>/<X>.md`.
- "Write wiki for all characters in chapter X" → expect 1+ `write` calls under `wiki/character/`.
- "What happened in this chapter?" → expect a single assistant turn ending in `</tool_call>` (no writes).
- "Do you see any problems with this chapter?" → expect `read` → assistant text.
- "Evaluate how complete _plan.md is" → expect `read` of `_plan.md` → assistant text.

Each case is one of:
- **mock-mode**: uses the EvalGateway with injected responses (oracle-style), asserts on `controller.runAgentHierarchy` output.
- **live-mode**: hits `:3130` (inference:start) and asserts on actual model output.

### D.iii Grammar strictness policy
Document this in `AGENTS.md` "Grammar strictness":
- **Examples** show the *preferred* output (every line indented, well-formed think block, etc.). They are the stylistic ground truth.
- **Grammar** is the *most lenient valid* format — it enforces:
  - Block-level indentation for content lines (each non-empty line starts with `\t`).
  - Anywhere in the message: `<think>…</think>` and/or `<tool_call>…</tool_call>`.
  - JSON inside `<tool_call>` parses as `{name, arguments}`.
- **Anything more than that** is desirable but not required by the grammar. This means:
  - Stylistic variations (no think block, multiple think blocks, free text) still parse.
  - Mixture of tabs/spaces is OK as long as JSON validity holds — but the trainer/eval rewards the canonical format.
- **Action**: relax the validate rules in `eval-controller.ts` (`validateAssistantOutput`) to only check the LEANIENT grammar contract — not the strict tab-only layout. Keep `validateExampleFormat` strict so that *examples* never drift.

### Sub-tasks
- D1. `src/eval/eval-gateway.ts` — EvalGateway in-process mode.
- D2. `src/eval/cases/*.jsonl` — fixtures per scenario.
- D3. `src/eval/story-creation.eval.ts` — refactored to delegate to EvalController + cases.
- D4. Grammar relaxation in `validateAssistantOutput`; keep `validateExampleFormat` strict.
- D5. New `pnpm eval:cases` and `pnpm eval:cases:live` scripts.

## E. storyteller examples — frontmatter think blocks
- Each example `.md` file in `src/agents/storyteller/examples/story-*/` gets a YAML frontmatter block at the top:
  ```
  ---
  think: |
    <one-paragraph narration about the STORY the file belongs to, what this file's role is, and what lane the model should stay in>
  ---
  # Chapter 1: ...
  ```
- The `loadStorytellerExamples` loader reads frontmatter and injects the `think` content as the first `think` entry for that file's example turn (so the rendered example prompt has the target think block in the right slot).
- Goal: each rendered example shows the model *exactly* how to think about each step of a real story (not just generic "write chapter 2 deeper relationships" copy).

### Sub-tasks
- E1. Update `src/agents/storyteller/examples.ts` to read frontmatter.
- E2. Add frontmatter to all `story-*/*.md` files (3 stories × ~6 files each = ~18 files).
- E3. Eval still 40/40 (frontmatter doesn't break the GBNF format).

## F. state tuning — skip reprocessing when hash matches
- The agent loop currently calls `model.process({systemPrompt, append: examples})` every time. For long examples this is wasteful.
- Add a content hash:
  - Compute `SHA256(examples + systemPrompt)`.
  - Cache the processed answer/tokenization result keyed by hash.
  - On cache hit: skip the `process` call, return the cached session-id.
- Use a tiny on-disk cache under `.cache/state-tune/<hash>.bin` — survives restarts.

### Sub-tasks
- F1. `src/core/state-tune-cache.ts` — get/set by content hash.
- F2. Wire into `AgentLoop` constructor or first `run` call.
- F3. `--no-cache` flag for tests that need fresh reprocessing.
- F4. Test: same examples loaded twice → exactly one process call.

## G. model VRAM residency — keep model in RAM, only load to VRAM on demand
- Right now `NativeRwkvModel.init` keeps the model pinned in VRAM forever.
- Want: regular-RAM resident base weights; **vulkan/cuda context only on demand**.
- Approach:
  - Split `init` into two phases:
    - `loadToRam()` — read safetensors into host memory once.
    - `bindToGpu()` — copy buffers to VRAM and compile the pipeline (called on first generation, or background-prefetched).
    - `unbindFromGpu()` — release VRAM when idle (`resetIdleTimer` triggers after `--idle-vram-secs=NN` seconds).
  - The Rust binding already exposes the underlying `Instance` / context; expose `bind`/`unbind` from `lib.rs` and re-wrap in `NativeRwkvModel`.

### Sub-tasks
- G1. `lib.rs`: add `bindGpu()`, `unbindGpu()`, `isGpuBound()` exports.
- G2. `native-rwkv-model.ts`: add the same methods + an idle timer in the singleton.
- G3. CLI: `--idle-vram-secs=NN` (default 300s = 5 min).
- G4. Eval: assert that an idle period evicts VRAM and a new request rebinds (smoke test only, not blocking CI).

## Order of operations (rough)

1. F (state-tune cache) — small, isolated, has clear win.
2. A (trace-writer to core) — small refactor; touches every eval path. Do early.
3. B (log streaming) — needs A done first.
4. D.iii (grammar strictness docs + relax validator) — quick.
5. C (workspace modes) — touches a lot of code paths.
6. D.i/ii (oracle-via-gateway + targeted cases) — biggest eval change.
7. E (storyteller frontmatter) — content, no architecture.
8. G (VRAM residency) — biggest perf change; do last to avoid rework.

## Tests (run after each chunk)
- `pnpm typecheck`
- `pnpm eval` — oracle, expect 40/40
- `pnpm test:grammar` — three grammar suites
- `pnpm test:trace` — 23/23
- `pnpm test:agent` — 11/11
- new tests written alongside each chunk
