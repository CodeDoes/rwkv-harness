/**
 * Back-compat shim. The trace writer was promoted into core so it is
 * usable from CLI / gateway / eval / tests with the same lifecycle.
 * Re-exports the public API from src/core/trace-writer.ts.
 *
 * The default trace directory moved from
 *   src/eval/.traces/
 * to
 *   <cwd>/.traces/
 * Set `TRACE_DIR` env var to override (or pass `tracesDir` to the
 * constructor).
 */
export {
  TraceWriter,
  type TraceRole,
  type TraceFormat,
  type IndentStyle,
  type TraceFormatOpts,
} from "../core/trace-writer.ts"
