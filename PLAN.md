# Next Steps

Forward-looking plan after the 6-phase architecture refactoring (ARCH.md, commits 81e0d88–c261cc4). Items here are deliberate, prioritized, and reachable within a quarter.

## Completed (ARCH_DIFF.md Phases 1–6)

- MessagePart, ResponseTemplate, StopReason (protocol layer)
- Tool class with Zod schemas, grammar(), exec()
- Agent class with tools + instructions + examples
- Session data class + SessionManager persistence bridge
- Model→Engine rename + RwkvEngineAdapter
- CacheProtocol + LocalInferenceClient + LocalServerControl
- AgentLoop holds Session; 11 callers migrated
- GatewayControl class; CLI always routes through gateway + HttpModel

## Priorities (P0 → P3)

### P0 — stabilize the inference loop

1. **Fix `pnpm eval:live`.** Still exits instantly in ~2s with empty assistant output. Likely a gateway readiness or HttpModel streaming issue. Add a `--mock-live` flag that uses MockModel for live checks to validate the eval harness itself, then diagnose the real model path separately.
2. **Reproduce & close empty-generation bug.** ✅ Root cause: grammar `root ::= ws? (...)*` allowed zero content blocks — model emitted whitespace and grammar signaled completion. Fixed: `*` → `+`. Live eval now generates 315 tokens vs 1. Still needs prompt tuning to make model call tools.
3. **Tool-response placement bake-off.** ✅ Done — both placements pass oracle 29/29 and trace 23/23. `block` remains default (model sees tool results; `inline` skips feeding them back). Benchmark: `pnpm bench:placement`.
4. **Grammar regression tests in CI.** Oracle eval (29/29) and `test:trace` (23/23) already wire GBNF. Document as the regression baseline; consider a GitHub Actions workflow.

### P1 — broaden format experiments

5. **`SUBAGENT_WRAP=xml` bake-off.** Compare traces with vs without wrapping; decide whether `<subagent name="X">` becomes default or stays env-gated.
6. **Multi-template renderers.** Add a `compact` template (no leading `\t` indentation) to `example-template.ts` so the same data renders in both layouts — verifies tag-level invariants.
7. **Test-mode tool-result introspection.** Capture every `ToolResult` into a structured sidecar (`sessions/<id>/tool-results.jsonl`) so eval can diff tool-result outcomes against mock expectations.

### P2 — channel + transport

8. **Migrate legacy GatewayServer ad-hoc routes to oRPC.** The `/v1/generate`, `/v1/stream`, `/chat`, etc. endpoints still exist for backward compat. Remove them; the only route should be `/rpc/*` (AGENTS.md marks these as ⏳).
9. **Multi-channel broadcast test.** Webapp + TUI + CLI connected to same gateway must see the same conversation. Add a `test:trace`-style fixture that runs two channels in parallel and asserts both received every token.
10. **Per-session sandbox in `--no-gateway` mode.** Sandbox is currently eval-only. Lift the sandbox helper out of `EvalController`.

### P3 — larger initiatives (express intent, not hours)

11. **MoSE stubs → real implementation.** `NativeRwkvModel.mose` (createExpert, apply, segmentRoute) are no-ops. Reference web-rwkv's axum example and link them to the binding.
12. **LoRA adapter stubs → real implementation.** Same as MoSE — `loraMgr` methods are no-ops. Wire through to web-rwkv's LoRA C API.
13. **GatewayControl integration tests.** Start/stop/restart lifecycle, health polling, reconnect after gateway restart.
14. **Skills system.** Move `agents/{envoy,storyteller}` toward `skills/<name>/{index.ts,examples.ts,tools/*.ts}` so agents compose of skills.
15. **Long-term memory.** State archiving + retrieval via MoSE blend back into the live session.
16. **Cron / scheduled tasks.** Schedule a `tell` or `agent` invocation against the gateway at a scheduled time.

## Process

- After completing items, update this file and mark progress in the eval trace.
- Keep `ARCH.md` in sync with any new component or contract change.
- Avoid editing `docs/`; active docs are `ARCH.md`, `AGENTS.md`, `ARCH_DIFF.md`.

## Success criteria for P0 close

- `pnpm eval` → 29/29 PASS.
- `pnpm test:trace` → 23/23 PASS.
- `pnpm eval:live` (gateway up) → no empty assistant turns (✅ fixed); model still needs prompt tuning to reliably call tools.
- `pnpm typecheck` → clean.
