# TODO Progress

Live working log. Updated as items in `TODO.md` make progress. See `TODO_PLAN.md` for the plan checklist and `NEXT_STEPS.md` for future work.

## Status legend

- ✅ done
- 🟡 in progress
- ⏸ blocked
- 🟢 parked (deferred, kept for context)

---

## 11. Remove `docs/` directory                                              ✅ 2026-07-04
- Removed via `git rm -r docs/`. Trash directory had stale agent-behavior, future/, synthdata/ files. No code referenced it.

## 10. Move `zod-to-gbnf.ts` / `zod-to-json.ts` to `src/tools/utils/`        ✅ 2026-07-04
- Both files relocated. `tools/registry.ts` import updated. `AGENTS.md` row updated. Typecheck clean.

## 15. Centralize format config in one place                                 ✅ 2026-07-04
- Added `src/agents/format-config.ts` exposing `getFormatConfig()` (frozen), plus render helpers (`renderToolResponseBlock`, `formatAssistantRole`, `formatToolResponseRole`, `wrapSubagent`, `tag`, `indentContent`).
- Schema covers SEP, stop sequences, role markers, tool-response placement (`block`/`inline`), subagent wrapping (`xml`/`none`), indent style, tool-result truncation.
- Env overrides: `SEP`, `STOP_SEQ`, `TOOL_RESPONSE_PLACEMENT`, `SUBAGENT_WRAP`, `INDENT_STYLE`.
- Replaced module-level constants in `loop.ts` (`SEP`, `STOP_SEQ`).
- `trace-writer.ts` now imports `getFormatConfig()` instead of reading env directly.

## 3. `toolResponseMode = block` vs `inline` (TODO #13)                       ✅ 2026-07-04
- `cfg.toolResponse.placement === "inline"` switches the loop to skip the explicit `User:\n<tool_response>...</tool_response>` turn and rely on a tag glued to `</tool_call>` directly. Default stays `block` for compatibility.

## 14. Subagent trace exception (TODO #14)                                     ✅ 2026-07-04
- Added `TraceWriter.writeSubagent(name, role, content)`. When `SUBAGENT_WRAP=xml` is set, output is wrapped `<subagent name="X">...</subagent>`. When unset, it's transparent.
- `eval-controller.ts` now narrates the storyteller subagent:
  - `onRawOutput` → `traceWriter.writeSubagent("storyteller", "assistant", raw)`
  - `onToolResult` → `traceWriter.writeSubagent("storyteller", "tool", JSON.stringify(result))`

## 1. Empty assistant turn in `2026-07-03T21-33-29-220Z_live.txt`            🟡 diagnosing
- Added an empty-stream guard in `agents/loop.ts:run`. When `raw.trim().length === 0` the loop now writes `[agent-loop] WARN: empty generation at depth N (stopReason=...)` into the run log and breaks the loop instead of saving an empty `\n\n` assistant turn.
- Underlying cause (stale checkpoint state, EOS-in-prompt collision, model malformation when `STOP_SEQ` fires before any token) still requires live-mode reproduction — fix to be verified after `pnpm eval:live` once gateway is restarted on the new binding.

## 2. Looptest trace `2026-07-03T21-41-50-877Z_looptest.txt`                  ✅ 2026-07-04
- Rewrote `traceShapeAgentLoopTest` in `src/eval/trace-writer.test.ts` to wire `onToolResult → tw.write("tool", JSON.stringify(result))`.
- Updated `writeRoleInterleavingTest` the same way.
- Added two new regression assertions:
  - `<tool_call>[\s\S]*?\n\t<tool_response>` — a tool_call must be followed by a tool_response in the trace.
  - `tool response emitted between assistant turns` ordering check.
- All 23/23 trace shape tests now pass.

## 9. Write `ARCHITECTURE.mdx` with a dolphin (sequence) diagram               ✅ 2026-07-04
- Doc covers: layered box diagram, mermaid sequence for `pnpm eval:live`, module map, state/data-flow rules, failure modes, references.

## 12 (last). git commit                                                      🟢 parked
- Awaiting NEXT_STEPS + final review.

---

## Out of scope (parked)

- MoSE/MoLE live wiring (engine already exposes synthetic mappers; gateway has handlers; rest is glue).
- Channel-agnostic session routing / file-watcher (`Phase 4` in `PLAN.md`).
- Skills system, long-term memory, cron, training pipeline (archived).

## Open questions (deferred)

- Should the "block" placement keep `User:\n` or be moved to system-prompt text? Tied to grammar sensitivity for `toolsToGbnfWithThink`. Worth a small benchmark before default changes.
