# PLAN

## 1. Consolidate examples to `src/agents/*/examples.ts` with rich think tags
- Move JSONL example files (`src/agents/envoy/examples/spawn_story.jsonl`) into `src/agents/envoy/examples.ts` as TS array.
- Keep `src/agents/storyteller/examples.ts` but rewrite the loader so it builds three narrated, multi-paragraph `think` blocks per story — narrating strategy ("User wants X → check workspace → write plan → write chapters → wiki"), instead of terse one-liners.
- Make the think tags "more interesting": a mini-monologue describing strategy, file naming, parallelism, and intent per step. Also include one or two `think` blocks that mention the envoy behavior (storyteller's `think` references the user request, the agent's role, and the output rules).
- Verify with `pnpm eval` (rendered → GBNF validator) that examples still parse.

## 2. Add `pnpm run grammar:preview` → `.preview.grammar`
- Create `scripts/preview-grammar.ts` that loads each grammar producer (`toolsToGbnf`, `toolsToGbnfWithThink`, `toolsToGbnfText`, `toolsToGbnfZod`) and writes outputs to `.preview.grammar` (or one file per variant to `.preview.grammar.{tool,think,text,zod}`).
- Add the script to `package.json`.

## 3. Tests for grammar — three test files
- `src/grammars/grammar-valid.test.ts` — compile each grammar with `schoolmarm` (install dep if missing under `native/rwkv-bindings` or add to root `devDependencies`); verify `Grammar.new(gbnf)` succeeds for every variant + per-agent grammar.
- `src/grammars/grammar-invalid.test.ts` — feed malformed GBNF (missing `::=`, dangling reference, bad rule name with `-`); expect compile throw / parser error.
- `src/grammars/grammar-gen.test.ts` — feed a fixture of expected tool-call JSON text into `GrammarState` and assert the allowed-mask covers the JSON and excludes arbitrary prose; verify the same for the think-block+text+call root.
- Wire each into `package.json` scripts: `test:grammar:valid`, `test:grammar:invalid`, `test:grammar:gen`.

## 4. Add `pnpm run inference:start`
- A simple script that starts the gateway/inference engine in **daemon mode (nohup, detached)** so it survives gateway-restart cycles invoked from other tooling.
- Implementation: `bash scripts/start-inference.sh` or an equivalent `pnpm` script that uses `nohup tsx src/cli.ts gateway > .inference.log 2>&1 &`, writes PID to `.inference.pid`, and prints confirmation. Critically, it does NOT tie the process to the gateway-start script's shell.
- Add a `inference:stop`, `inference:status`, `inference:logs` to mirror the gateway controls.

## 5. Envoy examples — clarify role + seedlings
- Add **3-4 new examples** to `src/agents/envoy/examples.ts` so the model sees multiple "user gives a vague intent → envoy extracts seedlings (a premise + ~3 character/place/faction seeds) and delegates the rest as a task to storyteller, **not** the full outline".
- Examples should demonstrate:
  - The envoy DOES NOT write the story itself.
  - The envoy DOES NOT micro-manage the storyline.
  - The envoy extracts storyline seedlings from user input and passes them as a `task` string to the storyteller.
- Add a sentence to `instructions.mdx` clarifying "you delegate, you don't write — pass seedlings to spark the scene; the storyteller expands and structures the world."

## Tests
Run after each chunk:
- `pnpm typecheck`
- `pnpm eval` (40 oracle checks — survives as long as examples are still GBNF-valid)
- new grammar test scripts
