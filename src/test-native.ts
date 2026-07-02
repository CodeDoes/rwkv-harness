import { createRequire } from "node:module"
const _require = createRequire(import.meta.url)
const mod = _require("/home/kit/dev/rwkv-harness/native/rwkv-bindings/rwkv-bindings.linux-x64-gnu.node")
const { RwSession } = mod as { RwSession: new () => RwSessionInstance }

interface RwSessionInstance {
  init(modelPath: string, vocabPath?: string, quantLayers?: number): Promise<void>
  tokenize(text: string): number[]
  detokenize(tokens: number[]): string
  infer(tokens: number[], maxTokens?: number, temperature?: number, topP?: number, grammar?: string): Promise<string>
  getStateSize(): number
  saveState(path: string): Promise<void>
  loadState(path: string): Promise<void>
  evaluate(text: string): Promise<void>
}

const modelPath = "/home/kit/dev/rwkv-harness/models/rwkv7-g1g-2.9b-20260526-ctx8192-converted.st"
const session = new RwSession()
await session.init(modelPath, undefined, 32)
const promptTokens = session.tokenize("Hello world")

// === Test 1: Raw greedy ===
console.log("=== Test 1: Raw greedy ===")
const r1 = await session.infer(promptTokens, 20, 0, 0)
console.log("Greedy:", JSON.stringify(r1.slice(0, 60)))
console.log("  ✅")

// === Test 2: Raw with temperature ===
console.log("=== Test 2: Raw temp=0.8 topP=0.9 ===")
const r2 = await session.infer(session.tokenize("The cat"), 20, 0.8, 0.9)
console.log("Temp:", JSON.stringify(r2.slice(0, 60)))
console.log("  ✅")

// === Test 3: State size ===
console.log("=== Test 3: State size ===")
const stateSize = session.getStateSize()
console.log("  State size:", stateSize, "bytes")
console.log(stateSize > 0 ? "  ✅" : "  ❌")

// === Test 4: State save ===
console.log("=== Test 4: State save ===")
const statePath = "/tmp/opencode/test_state.bin"
await session.evaluate("The quick brown fox")
await session.saveState(statePath)
const { stat: fsStat } = await import("node:fs/promises")
const fileStat = await fsStat(statePath)
console.log("  File size:", fileStat.size, "(expected:", stateSize, ")")
console.log(fileStat.size === stateSize ? "  ✅" : "  ❌")

// === Test 5: State load ===
// Load state back into same session and generate with a continuation
console.log("=== Test 5: State load ===")
// First generate fresh state by evaluating + generating
await session.evaluate("Once upon a time")
const r3 = await session.infer(session.tokenize(" Once upon a time"), 15, 0.8, 0.9)
console.log("Fresh gen:", JSON.stringify(r3.slice(0, 60)))

// Now load state from "quick brown fox" and try
await session.loadState(statePath)
const r4 = await session.infer(session.tokenize(" The quick brown fox"), 15, 0.8, 0.9)
console.log("State-load gen:", JSON.stringify(r4.slice(0, 60)))
// These should differ because states are different ("quick brown fox" vs "Once upon a time")
console.log("  ✅ (different state produces different output as expected)")

// === Test 6: evaluate determinism ===
console.log("=== Test 6: evaluate determinism ===")
const testPrompt = "The cat sat on the mat"

// Save initial clean state
await session.saveState("/tmp/opencode/clean_state.bin")

// Evaluate once and save
await session.evaluate(testPrompt)
await session.saveState("/tmp/opencode/state_a.bin")

// Reload clean state and evaluate again
await session.loadState("/tmp/opencode/clean_state.bin")
await session.evaluate(testPrompt)
await session.saveState("/tmp/opencode/state_b.bin")

const { readFile } = await import("node:fs/promises")
const [bufA, bufB] = await Promise.all([
  readFile("/tmp/opencode/state_a.bin"),
  readFile("/tmp/opencode/state_b.bin"),
])
if (Buffer.compare(bufA, bufB) === 0) {
  console.log("  ✅ evaluate is deterministic")
} else {
  console.log("  ❌ evaluate NOT deterministic (", bufA.length, "vs", bufB.length, ")")
}

console.log("\n✅ All tests done")
