#!/usr/bin/env node
/**
 * VRAM residency — smoke test. Verifies the public surface
 * (unbindFromGpu / bindToGpu / isGpuBound) is exposed by the
 * NativeRwkvModel class and that the Rust binding exports the
 * matching methods.
 *
 * Not a behavioural test (no model file is loaded), but it catches
 * silent regressions in the binding rename chain
 *     prepare_ram -> prepareRam, unbind_gpu -> unbindGpu, ...
 * that would otherwise only surface during a live run.
 */
import { createRequire } from "node:module"
import * as url from "node:url"

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`) }
}

function main() {
  console.log("\n── native binding renamed exports ──")
  const _require = createRequire(import.meta.url)
  const mod = _require(url.fileURLToPath(new URL("../../native/rwkv-bindings/rwkv-bindings.linux-x64-gnu.node", import.meta.url)))
  const proto = mod.RwSession.prototype
  const expected = ["prepareRam", "bindGpu", "unbindGpu", "isGpuBound"]
  for (const m of expected) {
    check(`RwSession.prototype has ${m}`, typeof proto[m] === "function")
  }

  console.log("\n── NativeRwkvModel exposes the same surface ──")
  // Lazy import — clazz is loaded only when needed; we just want to
  // inspect the prototype.
  import("./native-rwkv-model.ts").then((raw) => {
    const ns = raw as unknown as { NativeRwkvModel: { prototype: { [k: string]: unknown } } }
    const proto = ns.NativeRwkvModel.prototype
    for (const m of expected.slice(0)) {
      // TS names: prepareRam → (we expose as bindToGpu / unbindFromGpu /
      // isGpuBound; prepareRam exists only on the binding)
    }
    check("NativeRwkvModel.unbindFromGpu is a function", typeof proto.unbindFromGpu === "function")
    check("NativeRwkvModel.bindToGpu is a function", typeof proto.bindToGpu === "function")
    check("NativeRwkvModel.isGpuBound is a function", typeof proto.isGpuBound === "function")

    console.log(`\n${pass}/${pass + fail} PASS`)
    if (fail > 0) {
      console.log("\nFailures:")
      failures.forEach((f) => console.log(`  - ${f}`))
      process.exit(1)
    }
    process.exit(0)
  }).catch((e) => {
    fail++
    failures.push(`NativeRwkvModel import threw: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  [FAIL] NativeRwkvModel import: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`\n${pass}/${pass + fail} PASS`)
    process.exit(1)
  })
}

main()
