# TODO

Tracked follow-ups. Lightweight — each entry links to the relevant files.

## Storyteller finish tool (configurable)

The `spawn_agent` tool should tell the subagent (storyteller) to call a completion tool
when done. The completion tool name (`finish` / `end` / `report_completion` / `plan` /
`todo`) should be configurable per invocation so different agents/calls can request
different completion semantics.

Scope:
- Add a `finish` tool (or equivalent) to the storyteller tool set — calls it once when
  all work is done and returns its result to the parent as the agent's completion signal.
- `spawn_agent` accepts an optional `finishTool` (or `onComplete`) parameter that is
  forwarded into the spawned agent's instructions, naming the tool the subagent should
  call to signal completion.
- Default value: `finish`. Configurable via spawn-agent arg and/or per-agent default in
  `agent-loader.ts`.
- Eval: oracle + live should assert storyteller calls the configured completion tool
  before `spawn_agent` returns.

Files likely touched:
- `src/agents/storyteller/tools/` — new tool file (mirrors `story-validate.ts` shape)
- `src/agents/storyteller/instructions.mdx` — mention the completion tool
- `src/agents/envoy/tools/` — pass through the completion tool name
- `src/agents/agent-loader.ts` — optional per-agent default
- `src/eval/story-creation.eval.ts` — completion-tool check
