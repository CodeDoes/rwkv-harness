import type { ExampleEntry } from "../example-template.ts"

interface StoryDefinition {
  slug: string
  description: string
  refDir: string
  wiki: {
    character: string
    location: string
    faction: string
  }
}

const STORIES: StoryDefinition[] = [
  {
    slug: "shadow-realm",
    description: "a shadow realm story",
    refDir: "story-shadow",
    wiki: { character: "mara", location: "duskfall", faction: "umbral-order" },
  },
  {
    slug: "dragon-realm",
    description: "a story about dragons",
    refDir: "story-tale",
    wiki: { character: "lyra", location: "dragon-peak", faction: "ashen-council" },
  },
  {
    slug: "starfall",
    description: "a starfall saga",
    refDir: "story-starfall",
    wiki: { character: "celeste", location: "starfall-crater", faction: "observatory-council" },
  },
]

function makeExample(def: StoryDefinition): ExampleEntry[] {
  const { slug, description, refDir, wiki } = def
  const ws = `workspace/${slug}`

  const lsArgs = JSON.stringify({ path: ws, recursive: true })
  const writeResult = JSON.stringify({ name: "write", result: { success: true } })
  const filesEmpty = JSON.stringify({ name: "ls", result: { files: [] } })

  return [
    { type: "user", content: `Create ${description} with 3 chapters and wiki. Use ${ws}` },
    { type: "think", content: "Check workspace, then write plan, chapters, and wiki." },
    { type: "tool_call", content: JSON.stringify({ name: "ls", arguments: { path: ws, recursive: true } }) },
    { type: "tool_response", content: filesEmpty },
    { type: "think", content: "Empty workspace. Write plan." },
    { type: "tool_call", content: JSON.stringify({ name: "write", arguments: { path: `${ws}/_plan.md`, content: `@./${refDir}/_plan.md` } }) },
    { type: "tool_response", content: writeResult },
    { type: "think", content: "Write chapter 1." },
    { type: "tool_call", content: JSON.stringify({ name: "write", arguments: { path: `${ws}/chapter-001.md`, content: `@./${refDir}/chapter-001.md` } }) },
    { type: "tool_response", content: writeResult },
    { type: "think", content: "Write chapter 2." },
    { type: "tool_call", content: JSON.stringify({ name: "write", arguments: { path: `${ws}/chapter-002.md`, content: `@./${refDir}/chapter-002.md` } }) },
    { type: "tool_response", content: writeResult },
    { type: "think", content: "Write chapter 3." },
    { type: "tool_call", content: JSON.stringify({ name: "write", arguments: { path: `${ws}/chapter-003.md`, content: `@./${refDir}/chapter-003.md` } }) },
    { type: "tool_response", content: writeResult },
    { type: "think", content: "Write wiki entries." },
    { type: "tool_call", content: JSON.stringify({ name: "write", arguments: { path: `${ws}/wiki/character/${wiki.character}.md`, content: `@./${refDir}/wiki/character/${wiki.character}.md` } }) },
    { type: "tool_response", content: writeResult },
    { type: "think", content: "Write location wiki." },
    { type: "tool_call", content: JSON.stringify({ name: "write", arguments: { path: `${ws}/wiki/location/${wiki.location}.md`, content: `@./${refDir}/wiki/location/${wiki.location}.md` } }) },
    { type: "tool_response", content: writeResult },
    { type: "think", content: "Write faction wiki." },
    { type: "tool_call", content: JSON.stringify({ name: "write", arguments: { path: `${ws}/wiki/faction/${wiki.faction}.md`, content: `@./${refDir}/wiki/faction/${wiki.faction}.md` } }) },
    { type: "tool_response", content: writeResult },
    { type: "text", content: `Completed ${ws} with _plan.md, 3 chapters, and wiki (character, location, faction).` },
  ]
}

export function loadStorytellerExamples(): ExampleEntry[] {
  return STORIES.flatMap(makeExample)
}
