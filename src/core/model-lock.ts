/**
 * Model lock – a simple cross‑process guard that ensures the native RWKV
 * model is loaded at most once per host.
 *
 * Why:
 *   Loading the 2.9 B‑parameter model allocates a large chunk of GPU memory
 *   (≈ 12 GB before quantisation). When two processes accidentally try to
 *   load it at the same time the second allocation fails with a
 *   `wgpu error: Out of Memory` (the symptom we hit during the live eval).
 *
 * How:
 *   * We write a tiny lock file (`.locks/model.lock`) using `O_CREAT |
 *     O_EXCL` (Node's `'wx'` flag). The call is atomic; if the file already
 *     exists we abort with a clear error.
 *   * The file contains the PID of the owning process so an admin can see
 *     who is holding it.
 *   * We install `SIGINT`/`SIGTERM`/`exit` handlers that delete the lock so
 *     usual termination paths clean up.
 *
 * Usage:
 *   await acquireModelLock();   // throws if another process holds it
 *   … // initialise and use the native binding
 *   await releaseModelLock();   // called automatically on exit
 */

import * as fs from "fs/promises"
import * as path from "path"

const LOCK_DIR = path.join(process.cwd(), ".locks")
const LOCK_PATH = path.join(LOCK_DIR, "model.lock")

let alreadyHeld = false

/** Try to acquire the singleton model lock. Throws on conflict. */
export async function acquireModelLock(): Promise<void> {
  if (alreadyHeld) {
    throw new Error("Model already locked within this process")
  }

  await fs.mkdir(LOCK_DIR, { recursive: true })

  try {
    const handle = await fs.open(LOCK_PATH, "wx")
    await handle.writeFile(`${process.pid}\n`)
    await handle.close()
    alreadyHeld = true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // Try to read the holder PID for a nicer error message.
      let holder = "unknown"
      try {
        const buf = await fs.readFile(LOCK_PATH, "utf8")
        holder = buf.trim() || holder
      } catch { /* ignore */ }
      throw new Error(
        `Model is already loaded by another process (pid ${holder}). ` +
          `If you are sure it is stale, delete ${LOCK_PATH} and try again.`,
      )
    }
    throw e
  }

  // On normal termination (Ctrl‑C, kill, process exit) drop the lock so the
  // next start can succeed.
  const release = () => {
    try {
      // Use sync FS because the process is exiting.
      const { unlinkSync, existsSync } = require("fs") as typeof import("fs")
      if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH)
    } catch { /* ignore */ }
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      release()
      process.exit(0)
    })
  }
  process.on("exit", release)
}

/** Explicitly release the lock (normally handled automatically). */
export async function releaseModelLock(): Promise<void> {
  if (!alreadyHeld) return
  try {
    await fs.unlink(LOCK_PATH)
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw e
  } finally {
    alreadyHeld = false
  }
}

/** For diagnostics – returns the PID that currently holds the lock, if any. */
export async function currentLockHolder(): Promise<string | null> {
  try {
    const buf = await fs.readFile(LOCK_PATH, "utf8")
    return buf.trim() || null
  } catch {
    return null
  }
}
