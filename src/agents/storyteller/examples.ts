import type { ExampleEntry } from "../example-template.ts"

interface WikiEntry {
  slug: string
  category: string
  content: string
  thinkPrefix: string
}

interface StoryDefinition {
  slug: string
  refDir: string
  userPrompt: string
  wikiSegments: WikiEntry[]
}

const STORIES: StoryDefinition[] = [
  {
    slug: "shadow-realm",
    refDir: "story-shadow",
    userPrompt: "@./story-shadow/_user.md",
    wikiSegments: [
      { slug: "mara", category: "character", content: "@./story-shadow/wiki/character/mara.md", thinkPrefix: "Write character wiki entry." },
      { slug: "duskfall", category: "location", content: "@./story-shadow/wiki/location/duskfall.md", thinkPrefix: "Write location wiki." },
      { slug: "umbral-order", category: "faction", content: "@./story-shadow/wiki/faction/umbral-order.md", thinkPrefix: "Write faction wiki." },
    ],
  },
  {
    slug: "dragon-realm",
    refDir: "story-tale",
    userPrompt: "@./story-tale/_user.md",
    wikiSegments: [
      { slug: "lyra", category: "character", content: "@./story-tale/wiki/character/lyra.md", thinkPrefix: "Write character wiki entry." },
      { slug: "dragon-peak", category: "location", content: "@./story-tale/wiki/location/dragon-peak.md", thinkPrefix: "Write location wiki." },
      { slug: "ashen-council", category: "faction", content: "@./story-tale/wiki/faction/ashen-council.md", thinkPrefix: "Write faction wiki." },
    ],
  },
  {
    slug: "starfall",
    refDir: "story-starfall",
    userPrompt: "@./story-starfall/_user.md",
    wikiSegments: [
      { slug: "celeste", category: "character", content: "@./story-starfall/wiki/character/celeste.md", thinkPrefix: "Write character wiki entry." },
      { slug: "starfall-crater", category: "location", content: "@./story-starfall/wiki/location/starfall-crater.md", thinkPrefix: "Write location wiki." },
      { slug: "observatory-council", category: "faction", content: "@./story-starfall/wiki/faction/observatory-council.md", thinkPrefix: "Write faction wiki." },
    ],
  },
]

function makeExample(def: StoryDefinition): ExampleEntry[] {
  const { slug, refDir, wikiSegments } = def
  const ws = `workspace/${slug}`

  const lsArgs = JSON.stringify({ path: ws, recursive: true })
  const writeResult = JSON.stringify({ name: "write", result: { success: true } })
  const filesEmpty = JSON.stringify({ name: "ls", result: { files: [] } })

  const entries: ExampleEntry[] = [
    { type: "user", content: def.userPrompt },
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
  ]

  for (const seg of wikiSegments) {
    entries.push({ type: "think", content: seg.thinkPrefix })
    entries.push({
      type: "tool_call",
      content: JSON.stringify({ name: "write", arguments: { path: `${ws}/wiki/${seg.category}/${seg.slug}.md`, content: seg.content } }),
    })
    entries.push({ type: "tool_response", content: writeResult })
  }

  entries.push({ type: "text", content: `Completed ${ws} with _plan.md, 3 chapters, and wiki.` })

  return entries
}

export function loadStorytellerExamples(): ExampleEntry[] {
  return STORIES.flatMap(makeExample)
}
