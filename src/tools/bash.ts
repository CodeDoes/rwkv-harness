import { spawnSync } from "child_process"

/**
 * `bash` tool – run a single shell command (non‑interactive) and
 * return its captured stdout, stderr, and exit status.
 *
 * The tool is deliberately small: the agent loop decides whether to
 * invoke it; the harness provides no automatic permission prompts.
 *
 * Output is truncated to roughly 8 kB so huge `cat` commands don’t
 * blow up the context window.  The full output is *available* via the
 * `/tmp/rwkv‑bash.log` file – it is rewritten on every call.
 */
const MAX_OUTPUT = 8_000

export default function bash(
  { command }: { command: string },
): { stdout: string; stderr: string; exit: number; truncated: boolean } {
  const result = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf-8",
    cwd: process.cwd(),
    env: process.env,
  })

  const stdout = (result.stdout ?? "").toString()
  const stderr = (result.stderr ?? "").toString()
  const truncated = stdout.length + stderr.length > MAX_OUTPUT
  const truncOut = stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n[⋯ truncated]" : stdout
  const truncErr = stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n[⋯ truncated]" : stderr

  return {
    stdout: truncOut,
    stderr: truncErr,
    exit: result.status ?? 0,
    truncated,
  }
}
