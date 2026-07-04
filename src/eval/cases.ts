/**
 * Eval case fixtures. Each case is a small, targeted scenario the
 * storyteller or coder agent should handle:
 *
 *   - "write-chapter"   → journal / write one chapter.md
 *   - "wiki-from-chapter" → read chapter, write one wiki entry
 *   - "wiki-for-characters" → emit at least one character entry
 *   - "summarize-chapter"   → pure-prose response, no writes
 *   - "review-chapter"      → read + critique, no writes
 *   - "evaluate-plan"       → read _plan.md, no writes
 *
 * Each case specifies:
 *   - agent:    which specialist to drive
 *   - messages: ordered mock responses the model emits
 *   - checks:   each is { name, pass } — evaluated against the post-run
 *               file tree + the captured assistant texts
 *
 * Mock responses follow the project's prompt format
 * (default template): `\n\t<tool_call>\n\t{name,…}\n\t</tool_call>`.
 */
import * as fs from "fs"

export type AgentName = "envoy" | "storyteller" | "coder"

export interface CaseMockTurn {
  /** What the model emits this turn. */
  response: string
  /** Optional override name (defaults to "storyteller"). */
  agent?: AgentName
}

export interface CaseCheck {
  name: string
  pass: boolean
  detail?: string
}

export interface EvalCase {
  id: string
  description: string
  agent: AgentName
  userInput: string
  workspaceDir: string
  /** Files that must exist before the run begins (seed data). */
  seedFiles?: Record<string, string>
  /** Mock responses (one per model turn). */
  turns: CaseMockTurn[]
  /** Checks ran after the agent loop completes. */
  expectedFiles?: Array<{ match: (p: string) => boolean; path: string }>
  /** Evaluated by the runner. */
  evaluate: (ctx: { workspaceDir: string; turns: CaseMockTurn[]; capturedText: string[]; toolsCalled: string[] }) => CaseCheck[]
}

const TCALL = (payload: Record<string, unknown>) =>
  `\t<tool_call>\n\t${JSON.stringify(payload)}\n\t</tool_call>`

/**
 * Helper: a writer turn that emits a <tool_call> to write `path` with
 * `content`. Used in fixtures.
 */
function writeTurn(path: string, content: string): CaseMockTurn {
  return { response: TCALL({ name: "write", arguments: { path, content } }) }
}

/** Helper: a read turn. */
function readTurn(path: string): CaseMockTurn {
  return { response: TCALL({ name: "read", arguments: { path } }) }
}

/** Helper: a plain text turn (no tool_call). */
function textTurn(text: string): CaseMockTurn {
  return { response: text }
}

// ── Seeded ───────────────────────────────────────────────

export const CASES: EvalCase[] = [
  {
    id: "write-chapter",
    description: "Storyteller writes a single chapter file end-to-end.",
    agent: "storyteller",
    userInput: "Write a chapter called 'The Forge' about Kael's first encounter with a dragon.",
    workspaceDir: "workspace/forge",
    turns: [
      writeTurn("workspace/forge/chapter-001.md", "# Chapter 1: The Forge\n\nKael lit the furnace and waited.\n"),
      textTurn("Done — chapter-001.md written with the encouter scene."),
    ],
    evaluate: ({ workspaceDir }) => {
      const target = `${workspaceDir}/chapter-001.md`
      const exists = fs.existsSync(target)
      const content = exists ? fs.readFileSync(target, "utf-8") : ""
      return [
        { name: "chapter file exists", pass: exists },
        { name: "chapter content non-empty", pass: content.length > 0 },
        { name: "chapter filename has 3-digit padding (chapter-001.md)", pass: /chapter-\d{3}\.md$/.test(target) },
        { name: "content contains the requested title", pass: content.toLowerCase().includes("the forge") },
      ]
    },
  },

  {
    id: "wiki-from-chapter",
    description: "Storyteller reads a chapter then writes a wiki entry for its protagonist.",
    agent: "storyteller",
    userInput: "Write a wiki about Kael from chapter-001.md.",
    workspaceDir: "workspace/kaelwiki",
    seedFiles: {
      "workspace/kaelwiki/chapter-001.md": "# Chapter 1\n\nKael is the village blacksmith — quiet, careful, twenty-three years old.\n",
    },
    turns: [
      readTurn("workspace/kaelwiki/chapter-001.md"),
      writeTurn(
        "workspace/kaelwiki/wiki/character/kael.md",
        "# Kael\n\n**Role:** village blacksmith, age 23\n**Backstory:** introduced in chapter-001.\n",
      ),
      textTurn("Wiki entry for Kael saved at wiki/character/kael.md."),
    ],
    evaluate: ({ workspaceDir, toolsCalled, capturedText }) => {
      const target = `${workspaceDir}/wiki/character/kael.md`
      const exists = fs.existsSync(target)
      const content = exists ? fs.readFileSync(target, "utf-8") : ""
      return [
        { name: "read one chapter before writes", pass: toolsCalled.includes("read") },
        { name: "wiki entry file created", pass: exists },
        { name: "wiki content non-empty", pass: content.length > 0 },
        { name: "captured output mentions the wiki", pass: capturedText.some((t) => /wiki/i.test(t)) },
      ]
    },
  },

  {
    id: "wiki-for-characters",
    description: "When asked for wiki entries for every character in chapter 1, the agent emits at least one character entry.",
    agent: "storyteller",
    userInput: "Write wiki entries for every character that appears in chapter 1.",
    workspaceDir: "workspace/all-chars",
    seedFiles: {
      "workspace/all-chars/chapter-001.md": "# Chapter 1\n\nKael works the forge. Mara watches from the alley.\n",
    },
    turns: [
      readTurn("workspace/all-chars/chapter-001.md"),
      writeTurn(
        "workspace/all-chars/wiki/character/kael.md",
        "# Kael — blacksmith.\n",
      ),
      writeTurn(
        "workspace/all-chars/wiki/character/mara.md",
        "# Mara — alley-watcher.\n",
      ),
      textTurn("Two character profiles written."),
    ],
    evaluate: ({ workspaceDir }) => {
      const dir = `${workspaceDir}/wiki/character`
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(".md"))
        : []
      return [
        { name: "wiki/character dir created", pass: fs.existsSync(dir) },
        { name: "≥2 character entries", pass: files.length >= 2 },
      ]
    },
  },

  {
    id: "summarize-chapter",
    description: "When asked 'what happened in this chapter?', the agent emits pure-prose with no tool calls.",
    agent: "storyteller",
    userInput: "What happened in this chapter?",
    workspaceDir: "workspace/summary",
    seedFiles: {
      "workspace/summary/chapter-001.md": "Chapter 1: Kael lights the forge and meets Mara in the alley.\n",
    },
    turns: [
      readTurn("workspace/summary/chapter-001.md"),
      textTurn("In chapter 1 Kael lights the forge for the first time and meets Mara in the alley — a quiet, watchful figure."),
    ],
    evaluate: ({ toolsCalled, capturedText }) => {
      return [
        { name: "no write tool calls", pass: !toolsCalled.includes("write") },
        { name: "at least one prose response", pass: capturedText.length >= 1 && capturedText.some((t) => t.trim().length > 0) },
      ]
    },
  },

  {
    id: "review-chapter",
    description: "When asked 'do you see any problems with this chapter?', the agent reads then critiques.",
    agent: "storyteller",
    userInput: "Do you see any problems with this chapter?",
    workspaceDir: "workspace/crit",
    seedFiles: {
      "workspace/crit/chapter-001.md": "# Draft\n\nKael runs. He runned to the store.\n",
    },
    turns: [
      readTurn("workspace/crit/chapter-001.md"),
      textTurn("Two problems: tense inconsistency (Kael runs / he runned) and the time-of-day is left ambiguous."),
    ],
    evaluate: ({ toolsCalled, capturedText }) => {
      return [
        { name: "chapter was read first", pass: toolsCalled.includes("read") },
        { name: "produced a critique (not a write)", pass: !toolsCalled.includes("write") && capturedText.length >= 1 },
      ]
    },
  },

  {
    id: "evaluate-plan",
    description: "Reads _plan.md and returns a textual completeness assessment.",
    agent: "storyteller",
    userInput: "Evaluate how complete _plan.md is.",
    workspaceDir: "workspace/evalplan",
    seedFiles: {
      "workspace/evalplan/_plan.md": "# Plan\n\n- 3 chapters\n- character wiki\n- location wiki\n- faction wiki\n",
    },
    turns: [
      readTurn("workspace/evalplan/_plan.md"),
      textTurn("Plan looks complete: it lists chapter count plus each wiki category. Missing: chapter-by-chapter plots are not detailed."),
    ],
    evaluate: ({ toolsCalled, capturedText }) => {
      return [
        { name: "_plan.md was read", pass: toolsCalled.includes("read") },
        { name: "produced a written assessment", pass: capturedText.length >= 1 && capturedText.some((t) => t.trim().length > 0) },
      ]
    },
  },
]
