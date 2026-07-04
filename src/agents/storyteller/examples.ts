import type { ExampleEntry } from "../example-template.ts"

/**
 * Storyteller examples. The model uses these to learn:
 *   - The exact output shape: think -> tool_call -> read response -> think -> next call.
 *   - The output rules (.md files only, all-unique paths, full structure before stopping).
 *   - The strategy: plan first, then chapters, then wiki.
 *
 * The think blocks here are intentionally narrative — they explain WHY the
 * next call is happening, what the assistant is checking for, and how it ties
 * to the user's original request. This gives the model real reasoning to
 * imitate at inference time, instead of terse one-liners.
 */

interface WikiEntry {
  slug: string
  category: string
  content: string
  think: string
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
      {
        slug: "mara",
        category: "character",
        content: "@./story-shadow/wiki/character/mara.md",
        think:
          "Wiki character profile next — Mara is the thief protagonist. I want a tight profile: appearance, motivation (pay off a debt to the Umbral Order), quirks, and a sentence that connects her to the chapter events. Slug must be unique — kebab-case, like every other wiki entry.",
      },
      {
        slug: "duskfall",
        category: "location",
        content: "@./story-shadow/wiki/location/duskfall.md",
        think:
          "Now the location profile — Duskfall City is where the heist happens and where the spreading shadows converge. Capture atmosphere (the iron-and-stained-glass dome, alleys the protagonist knows by heart), the threat (the shadows spilling beyond the Archive), and one sensory detail that anchors a future chapter.",
      },
      {
        slug: "umbral-order",
        category: "faction",
        content: "@./story-shadow/wiki/faction/umbral-order.md",
        think:
          "Faction profile last — the Umbral Order is the moral-complicated antagonist. Note their official function (night-watch enforcers), their actual agenda (binding shadow-eaters), leadership, methods, and the secret pact that ties Mara to them. Without this entry the wiki feels one-dimensional.",
      },
    ],
  },
  {
    slug: "dragon-realm",
    refDir: "story-tale",
    userPrompt: "@./story-tale/_user.md",
    wikiSegments: [
      {
        slug: "lyra",
        category: "character",
        content: "@./story-tale/wiki/character/lyra.md",
        think:
          "Wiki character profile — Lyra is the bronze dragon, last of her kind. Profile needs age, scale/size, temperament (weary, fiercely protective), the wound Kael treated, and the emotional lever the story pulls on in chapter 3.",
      },
      {
        slug: "dragon-peak",
        category: "location",
        content: "@./story-tale/wiki/location/dragon-peak.md",
        think:
          "Wiki location profile — Dragon's Peak is the mountain range east of Emberhold. Describe the summit mist, the dragon-carved tunnels, and the lore of the dragon songs that locals still half-believe in. This gives future chapters a concrete place to revisit.",
      },
      {
        slug: "ashen-council",
        category: "faction",
        content: "@./story-tale/wiki/faction/ashen-council.md",
        think:
          "Wiki faction profile — the Ashen Council is the antagonist order. Their methods (ash-magic that suppresses dragon fire, enchanted compass trackers, scale bounties) make them feel credibly threatening. Leadership, HQ, motivation — without speakable motivation the third chapter's climax feels flat.",
      },
    ],
  },
  {
    slug: "starfall",
    refDir: "story-starfall",
    userPrompt: "@./story-starfall/_user.md",
    wikiSegments: [
      {
        slug: "celeste",
        category: "character",
        content: "@./story-starfall/wiki/character/celeste.md",
        think:
          "Wiki character profile — Celeste is the Observatory's chief astronomer who notices the falling star's trajectory is wrong. Profile: expertise, age, quiet obsession with the old star maps, the small superstition she keeps, and the disagreement with her Council that drives the plot.",
      },
      {
        slug: "starfall-crater",
        category: "location",
        content: "@./story-starfall/wiki/location/starfall-crater.md",
        think:
          "Wiki location profile — Starfall Crater is the impact site, a glass-floored depression on the high plains. Note the strange flora that arrived with the meteor, the crystals that hum at dawn, and the temperature anomaly that misleads Celeste's instruments at first.",
      },
      {
        slug: "observatory-council",
        category: "faction",
        content: "@./story-starfall/wiki/faction/observatory-council.md",
        think:
          "Wiki faction profile — the Observatory Council governs what counts as publishable sky-data. Their political caution (they suppressed previous anomalous reports to keep funding) is the institutional obstacle Celeste has to push past in chapter 3.",
      },
    ],
  },
]

function makeExample(def: StoryDefinition): ExampleEntry[] {
  const { slug, refDir, wikiSegments } = def
  const ws = `workspace/${slug}`

  const writeResult = JSON.stringify({ name: "write", result: { success: true } })
  const filesEmpty = JSON.stringify({ name: "ls", result: { files: [] } })

  const entries: ExampleEntry[] = [
    { type: "user", content: def.userPrompt },
    {
      type: "think",
      content:
        "The user wants a complete story package — a plan, three chapters, plus a worldbuilding wiki. Before I write anything I should peek at the workspace to make sure I'm not stomping on existing files or accidentally clobbering an earlier chapter. Always check first, write second.",
    },
    {
      type: "tool_call",
      content: JSON.stringify({
        name: "ls",
        arguments: { path: ws, recursive: true },
      }),
    },
    { type: "tool_response", content: filesEmpty },
    {
      type: "think",
      content:
        "Empty workspace, good — clean slate. Strategy: write the _plan.md FIRST so I lock the premise and the chapter beats, then write the three chapters in numbered order (chapter-001 → chapter-003), then a small wiki covering the most important character, location, and faction. The rules say I never write to the same path twice in a session, so each file gets exactly one write. Every file ends with .md.",
    },
    {
      type: "tool_call",
      content: JSON.stringify({
        name: "write",
        arguments: { path: `${ws}/_plan.md`, content: `@./${refDir}/_plan.md` },
      }),
    },
    { type: "tool_response", content: writeResult },
    {
      type: "think",
      content:
        "Plan in place. Now chapter 1 — establish the central character, the world they live in, and the inciting incident. Each chapter lives at chapter-001.md, chapter-002.md, chapter-003.md (zero-padded, never 'chapter_1.md'). I write the file once; if I have to fix a typo I use edit later, but for the initial draft it's one write per file.",
    },
    {
      type: "tool_call",
      content: JSON.stringify({
        name: "write",
        arguments: { path: `${ws}/chapter-001.md`, content: `@./${refDir}/chapter-001.md` },
      }),
    },
    { type: "tool_response", content: writeResult },
    {
      type: "think",
      content:
        "Chapter 1 saved. Chapter 2 should deepen the relationship introduced in chapter 1, raise the stakes, and end on a turn into the third act. I keep the prose style consistent — same POV tense, same paragraph rhythm — so the chapters feel like one book, not three sketches.",
    },
    {
      type: "tool_call",
      content: JSON.stringify({
        name: "write",
        arguments: { path: `${ws}/chapter-002.md`, content: `@./${refDir}/chapter-002.md` },
      }),
    },
    { type: "tool_response", content: writeResult },
    {
      type: "think",
      content:
        "Chapter 2 saved. Chapter 3 is the climax and resolution — resolve the inciting incident from chapter 1, pay off the setup in chapter 2, and land on an ending that respects the characters. Keep it tight; do not introduce new factions or magic rules in the final chapter.",
    },
    {
      type: "tool_call",
      content: JSON.stringify({
        name: "write",
        arguments: { path: `${ws}/chapter-003.md`, content: `@./${refDir}/chapter-003.md` },
      }),
    },
    { type: "tool_response", content: writeResult },
  ]

  for (const seg of wikiSegments) {
    entries.push({ type: "think", content: seg.think })
    entries.push({
      type: "tool_call",
      content: JSON.stringify({
        name: "write",
        arguments: { path: `${ws}/wiki/${seg.category}/${seg.slug}.md`, content: seg.content },
      }),
    })
    entries.push({ type: "tool_response", content: writeResult })
  }

  entries.push({
    type: "think",
    content:
      "All structure delivered. Before I stop I should sanity-check the deliverable count: one _plan.md, three zero-padded chapter files, and a wiki with at least one character, one location, one faction. The user instructions say I must complete the full structure before stopping, so I do not stop early even if I am tempted.",
  })
  entries.push({
    type: "text",
    content: `Completed ${ws} with _plan.md, 3 chapters, and a wiki covering a character, a location, and a faction.`,
  })

  return entries
}

export function loadStorytellerExamples(): ExampleEntry[] {
  return STORIES.flatMap(makeExample)
}
