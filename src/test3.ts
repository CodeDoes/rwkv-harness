import { NativeRwkvModel } from "./model/native-rwkv-model.ts"

const model = new NativeRwkvModel(
  "/home/kit/dev/rwkv-harness/models/rwkv7-g1g-2.9b-20260526-ctx8192-converted.st",
  "/tmp/opencode/test_state"
)
await model.init()

const r = await model.generate("Count to 3", { maxTokens: 30, temperature: 0 })
console.log("generate:", JSON.stringify(r), "len:", r.length)

const r2 = await model.generateStream("Hello", { onText: (t) => process.stdout.write(">>" + t) }, { maxTokens: 20, temperature: 0.8, topP: 0.9 })
console.log("\ngenerateStream:", JSON.stringify(r2), "len:", r2.length)

await model.dispose()
