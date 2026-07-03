# Todo Plan

Source: `TODO.md` (top-to-bottom, nested items ride along with their parent).

## Task checklist

- [ ] 1. **Fix trace `2026-07-03T21-33-29-220Z_live.txt`** — model emitted empty assistant turn. Diagnose then ensure the agent loop / streaming path always produces at least one token or surfaces the failure loudly (no silent zero-token result).
- [ ] 2. **Fix trace `2026-07-03T21-41-50-877Z_looptest.txt`** — assistant turn contains a `<tool_call>` with no `tool_response` follow-up. Decide whether (a) `<tool_response>` is mandatory after every `<tool_call>` and the loop recovers, or (b) the trace is missing the response line. Whichever, trace view post-fix must read as a valid conversation.
- [ ] 3. (sub of 2/15) **Add config flag to control tool_response placement** — flag `toolResponseMode: "block" | "inline"`. `block` (current default): `<tool_response>\n...\n</tool_response>` on its own turn. `inline`: `...\n</tool_call><tool_response>...</tool_response>`. Both supported via one central config (see 15).
- [ ] 14. (sub of 3) **Add eval exception for subagent traces** — when trace segments belong to a subagent, wrap with `<subagent name="...">...</subagent>` and use the inline-response format internally. Centralized via same config.
- [ ] 15. (sub of 3) **Centralize response / format config in one place** — single source of truth for SEP, STOP_SEQ, tool_response block/inline, tool_response tag format, subagent wrapping. Replace scattered constants with one config object the loop, trace-writer, and tests all read.
- [ ] 2(*). **Architectural reminder (target-state, not a coding task today)** — design intent:
  - [ ] eval intercepts inference calls
  - [ ] inference server (gateway) loads model, maintains state, generates output, processes input
  - [ ] agent lib/engine interacts with the gateway server
  - [ ] oRPC for the server↔client interaction
  - [ ] agent lib/engine manages tool call response + sandbox deployment
  - [ ] eval makes a sandbox in a temp folder
- [ ] 9. **Write `ARCHITECTURE.mdx` with a dolphin (sequence) diagram** covering model ↔ gateway ↔ agent ↔ channels ↔ eval ↔ sandbox interactions, matching the target architecture in 2(*).
- [ ] 10. **Move `zod-to-gbnf.ts` and `zod-to-json.ts` to `src/tools/utils/`** (or `src/utils/`). Update all imports.
- [ ] 11. **Remove `docs/` directory** — content is stale; superseded by ARCHITECTURE/NEXT-STEPS.
- [ ] 12. **Write `TODO_PROGRESS.md`** — running log of what's done, what's blocked, current in-progress.
- [ ] 13. **Write `NEXT_STEPS.md`** — forward-looking plan: prioritized next quarter of work beyond TODO.md.
- [ ] 12(last). **git commit everything** — final commit once checklist above is satisfied.

## Execution order (proposed)

1. Housekeeping: 11 → 10 → ARCHITECTURE.mdx (9) lives here so it reflects the refactored layout.
2. Central config: 15 → 3 → 14 (one PR-shaped pass; all of these are configuration plumbing).
3. Bug fixes: 1 → 2. After the central-config work lands, fix 1 + 2 against the new vocabulary and re-run `pnpm eval:live` so the trace viewer can be re-evaluated.
4. Docs closing: 12 → 13 → final commit.

## Blockers / open questions

- None yet. Will surface anything encountered during items 1 and 2.
