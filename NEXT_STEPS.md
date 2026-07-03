# Next Steps

Forward-looking plan beyond `TODO.md`. Items here are deliberate, prioritized, and reachable within a quarter (not the same horizon as `PLAN.md`).

## Priorities (P0 → P3)

### P0 — stabilize the inference loop

1. **Reproduce & close bug #1 with live model.** Restart gateway under the new `loop.ts` guard, run `pnpm eval:live`, capture trace. Every empty generation must now (a) write a `[agent-loop] WARN:` line and (b) abort cleanly. If the underlying cause is a stop-sequence-eating-prompt issue, narrow `STOP_SEQ` for the live eval.
2. **Default `TOOL_RESPONSE_PLACEMENT=block` benchmark.** Already the default. Add a `block` vs `inline` benchmark suite that runs both placements over the oracle's 27 checks and live's 16 checks. Promote whichever wins to default. Until then, `block` stays default.
3. **Grammar tests in CI.** `pnpm eval` oracle and `pnpm test:trace` already wire grammars; document them as the regression baseline and run on every commit.

### P1 — broaden format experiments

4. **`SUBAGENT_WRAP=xml` bake-off.** Compare traces with vs without wrapping; decide whether `<subagent name="X">` becomes default or stays env-gated. Watch for parser interference: any third-party trace viewer must still recognize tool calls inline within a wrapped block.
5. **Multi-template renderers.** Add a `compact` template (no leading `\t` indentation) to `example-template.ts` so the same data renders in both layouts — verifies tag-level invariants.
6. **Test-mode tool-result introspection.** Capture every `ToolResult` that ever crosses the loop into a structured sidecar (`sessions/<id>/tool-results.jsonl`) so eval can diff tool-result outcomes against mock expectations.

### P2 — channel + transport

7. **oRPC over WebSocket fully.** Currently the gateway has ad-hoc REST endpoints left over from before oRPC. Migrate the last of them to oRPC procedures (the WS broadcast lives outside oRPC — document the gap, then consider an `eventStream` helper or an SSE-callback wrapper).
8. **Multi-channel broadcast.** Webapp + TUI + CLI connected to a single gateway must see the same conversation. Currently it works because channels share the gateway round-trips; add a real test (`test:trace`–style fixture) that runs two channels in parallel and asserts both received every token.
9. **Per-session sandbox in `--no-gateway` mode.** Sandbox is currently eval-only. If the user runs a CLI story session with `--workspace=...`, the same should apply. Lift the sandbox helper out of `EvalController`.

### P3 — larger initiatives (express intent, not hours)

10. **Skills system.** Move `agents/{envoy,storyteller,coder}` toward `skills/<name>/{index.ts,examples.ts,tools/*.ts}` so agents compose of skills. Keep `agents/envoy` as the user-facing shim.
11. **Long-term memory.** State archiving + retrieval via MoSE blend back into the live session. Pre-req for any multi-week project.
12. **Cron / scheduled tasks.** Schedule a `tell` or `agent` invocation against the gateway at a `cron` time. Hooks into the existing route handlers; the orchestration is the new piece.

---

## Process changes

- After completing items, **update `TODO_PROGRESS.md` and bump the `next_steps` section here** — these two docs are paired with `PLAN.md` (arch roadmap) and act as the rolling ledger.
- Create `ARCHITECTURE.mdx` from new files every time a new component is added (matching diagram style + a mermaid sequence for the touch point).
- Avoid editing `docs/`; if legacy doc content is worth keeping, it must move into the active set (`ARCHITECTURE.mdx`, `AGENTS.md`, or a topic-led `docs/active/<topic>.md`).

## Success criteria for P0 close

- `pnpm eval` → 29/29 PASS.
- `pnpm test:trace` → 23/23 PASS.
- `pnpm eval:live` (gateway up) → no empty assistant turns; every `<tool_call>` in trace is followed by `<tool_response>`.
- `pnpm typecheck` → clean.
