import { NativeRwkvModel } from "./model/native-rwkv-model.ts"

const model = new NativeRwkvModel(
  "/home/kit/dev/rwkv-harness/models/rwkv7-g1g-2.9b-20260526-ctx8192-converted.st",
  "/tmp/opencode/test_state"
)
await model.init()

const { sessionId: sid1 } = await model.process()
const r = await model.generate({
  sessionId: sid1,
  prompt: "Count to 3",
  opts: { maxTokens: 30, temperature: 0 },
})
console.log("generate:", JSON.stringify(r.text), "len:", r.text.length)
await model.interrupt(sid1)

const { sessionId: sid2 } = await model.process()
let streamed = ""
const r2 = await model.streamGenerate({
  sessionId: sid2,
  prompt: "Hello",
  opts: { maxTokens: 20, temperature: 0.8, topP: 0.9 },
  onToken: (t) => {
    streamed += t
    process.stdout.write(">>" + t)
  },
})
console.log("\nstreamGenerate:", JSON.stringify(r2.text), "len:", streamed.length)
await model.interrupt(sid2)

await model.dispose()
