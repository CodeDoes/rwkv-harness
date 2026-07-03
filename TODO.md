# TODO

Tracked follow-ups. Lightweight — each entry links to the relevant files.

## Storyteller finish tool (configurable) — superseded

Originally planned, then the design was simplified: drop the finish tool entirely.
Take the sub-agent's last assistant text and feed it back into the parent's tool
response block, mirroring the real inference prompt sequence (`\n\ntool: ...`).
Implemented in `src/eval/eval-controller.ts` (spawn_agent handler now returns
`{summary: lastAssistantText}`); the parent trace no longer shows the parent's
separate "Briefly report..." turn.

## Gateway readiness for `eval:live`

`pnpm eval:live` polls `/rpc/health` until `status: "ok"`. Health now returns
`status: "starting"` while the gateway is still loading the model; the
client-side helper `tryConnectGateway` waits (default up to 5 minutes) and
returns the `HttpModel` once the model is ready.

Files:
- `src/rpc/contract.ts` — health output now `status: "ok" | "starting"`
- `src/rpc/server.ts:18` — health handler reads `modelReady()`
- `src/gateway/server.ts:54` — `markReady()`/`isReady()` flag, wired to oRPC
- `src/eval/story-creation.eval.ts:155` — polling helper used by `runLive`

## Open items (carryover)

- Update example JSONL / grammar `$ref` paths to match the new tag-indent
  style uniformly (currently auto-generated grammar is consistent; hand-
  authored JSONL examples may still mix styles).
- Consider replacing `Envoy` maxDepth=1 with explicit two-pass pattern so the
  parent naturally sees its tool responses in-session rather than via manual
  resume.
