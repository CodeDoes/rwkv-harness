/**
 * Workspace resolution.
 *
 * Two modes:
 *   "live"  — writes to `<cwd>/workspace/<slug>/` (and creates it if
 *             needed). Default for CLI commands so the user can review
 *             the deliverables afterwards.
 *   "temp"  — writes to a unique tmp dir per call, optionally
 *             auto-cleaned on teardown. Default for `pnpm eval`.
 *
 * Both modes are rooted in `<cwd>` so they always share the
 * common parent and the same `path.resolve` semantics. A `baseDir`
 * override lets callers (tests, gateway sub-sessions) anchor a private
 * tree elsewhere.
 */
import * as fs from "fs"
import * as path from "path"

export type WorkspaceMode = "live" | "temp"

export interface ResolveOpts {
  mode: WorkspaceMode
  slug?: string
  baseDir?: string
  /** Override the temp root. Default .tmp/workspace. */
  tempRoot?: string
  /** Override the live root. Default ./workspace. */
  liveRoot?: string
}

export interface ResolvedWorkspace {
  /** Absolute path that callers can write into. Guaranteed to exist. */
  path: string
  /** Mode used. */
  mode: WorkspaceMode
  /** Suggested slug (empty if anonymous). */
  slug: string
}

function slugify(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "anon"
}

export function resolveWorkspace(opts: ResolveOpts): ResolvedWorkspace {
  const slug = opts.slug ? slugify(opts.slug) : "anon"
  const cwd = process.cwd()

  if (opts.mode === "live") {
    const root = opts.baseDir
      ? path.resolve(opts.baseDir, opts.liveRoot ?? "workspace")
      : path.resolve(cwd, opts.liveRoot ?? "workspace")
    const target = path.join(root, slug)
    fs.mkdirSync(target, { recursive: true })
    return { path: target, mode: "live", slug }
  }

  // temp
  const root = opts.baseDir
    ? path.resolve(opts.baseDir, opts.tempRoot ?? ".tmp", "workspace")
    : path.resolve(cwd, opts.tempRoot ?? ".tmp", "workspace")
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const pid = process.pid.toString(36)
  const target = path.join(root, `${ts}_${pid}_${slug}`)
  fs.mkdirSync(target, { recursive: true })
  return { path: target, mode: "temp", slug }
}

/**
 * Best-effort cleanup of a temp workspace. Idempotent; safe to call
 * even if the workspace was never created.
 */
export function cleanupWorkspace(target: string): void {
  try {
    if (fs.statSync(target).isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true })
    }
  } catch {
    // already gone
  }
}

/**
 * Pick modes from common flags:
 *   --ephemeral     → temp
 *   --workspace=temp|live
 *   env WORKSPACE_MODE
 *
 * Default is "live".
 */
export function workspaceModeFromEnv(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): WorkspaceMode {
  for (const arg of argv) {
    if (arg === "--ephemeral") return "temp"
    if (arg === "--workspace=live") return "live"
    if (arg === "--workspace=temp") return "temp"
  }
  if (env.WORKSPACE_MODE === "temp") return "temp"
  if (env.WORKSPACE_MODE === "live") return "live"
  return "live"
}
