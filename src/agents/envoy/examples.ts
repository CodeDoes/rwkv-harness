import type { ExampleEntry } from "../example-template.ts"

/**
 * Envoy examples. The envoy is the user's front door. Its whole job is to:
 *  1. Read the user's intent.
 *  2. Pick the right specialist agent.
 *  3. Pass concise SEEDLINGS (premise + characters + setting seeds) as `task`,
 *     NOT a finished outline. The subagent expands them.
 *  4. Summarize deliverables when the subagent finishes.
 *
 * The think blocks below model the envoy's internal monologue — how it
 * decides what to keep vs. delegate, and why it never writes the story
 * itself.
 */

interface EnvoyExample {
  userPrompt: string
  task: string
  workspace: string
  summary: string
}

const EXAMPLES: EnvoyExample[] = [
  {
    userPrompt: "Create a story about dragons with 3 chapters and a wiki. Write files to workspace/dragon-tale",
    task: "Premise seeds for a dragon tale: (1) small blacksmith's apprentice discovers a wounded bronze dragon in a mountain ravine; (2) the dragon is a fugitive, the last of her kind; (3) an organized faction called the Ashen Council hunts dragons and is closing in. Cast: a young human protagonist, the bronze dragon, a Council envoy. Setting seeds: a mountain village on the edge of a wild frontier, a ruined council hall in a distant capital. Build a 3-chapter mystery-feel story with: a _plan.md outline, chapter-001.md/chapter-002.md/chapter-003.md, and a wiki/ with at minimum one character, one location, and one faction entry. Expand these seeds freely — name characters, define the artifact or prophecy tying them together, invent neighboring places. Keep chapters as chapter-001.md, chapter-002.md, chapter-003.md (zero-padded). All files end in .md.",
    workspace: "workspace/dragon-tale",
    summary: "Built workspace/dragon-tale/ — a 3-chapter dragon saga with a _plan.md outline and a wiki/ folder covering a character, a location, and the antagonist faction.",
  },
  {
    userPrompt: "write a short mystery set in a lighthouse, somewhere on the pacific. 3 chapters, wiki for the lighthouse and the keeper",
    task: "Premise seeds for a Pacific lighthouse mystery: (1) a reclusive keeper starts finding impossible messages in the logbook — entries they did not write, in their own handwriting, dated in the future; (2) the keeper is a former cryptographer who lost a colleague to an unsolved cipher case years ago; (3) the lighthouse sits on a basaltic headland with no road in, only a switchback trail. Cast: the keeper, a marine radio operator who keeps watch from a small port village, and an absent colleague whose case resurfaces. Setting seeds: the lighthouse interior (lantern room, library of logs, basement transmitter), the basaltic headland, the village at the trail's base. Build a 3-chapter mystery with: a _plan.md, chapter-001.md/chapter-002.md/chapter-003.md, and a wiki/ with at minimum one character entry, one location entry for the lighthouse. Expand the seeds — pick a year, invent radio chatter motifs, choose how the cipher works. Zero-padded chapter filenames (.md).",
    workspace: "workspace/lighthouse-cipher",
    summary: "Created workspace/lighthouse-cipher/ — 3 chapters of the cipher mystery plus a wiki with the keeper's profile and the lighthouse profile.",
  },
  {
    userPrompt: "I want a story about a kid who rides a giant mechanical spider through a dead city. 3 chapters, wiki for the spider and the city.",
    task: "Premise seeds for a mechanical-spider story: (1) a plucky young tinkerer inherits an abandoned steam-powered spider the size of a carriage from a vanished relative; (2) the city around them has been silent for decades — automated doors still open, laundry still turns on lines, but no people; (3) the spider runs on coal and a strange mineral only found beneath the city. Cast: the kid, the spider (treated like a stubborn familiar), a returning adult who finally arrived after decades of absence. Setting seeds: the dead city's central plaza, the kid's cluttered workshop, the underground where the mineral is mined. Build a 3-chapter adventure with _plan.md, chapter-001.md/chapter-002.md/chapter-003.md, and a wiki/ with at minimum one character entry, one location entry for the dead city, and one faction or artifact entry. Expand freely — name streets, invent a small mechanical failure the kid has to solve mid-chase, give the spider a personality. Zero-padded chapter filenames (.md).",
    workspace: "workspace/spider-city",
    summary: "Spawned workspace/spider-city/ — the spider adventure with the kid, the inherited steam-spider, and a wiki covering the character, the dead city, and the tinkerer background.",
  },
  {
    userPrompt: "Need a story about twins separated at birth who meet as rival chefs. 3 chapters, wiki them.",
    task: "Premise seeds for a twin-chef story: (1) two cooks in the same coastal city, raised on opposite sides of a family feud they did not know about, end up as finalists in the same televised cooking competition; (2) each twin cooks with one hand — a small inherited habit neither realizes is shared; (3) the showdown forces them to cook against each other for a prize neither wants more than the reconciliation. Cast: Twin A (the prodigy who left home early), Twin B (the steady restaurant chef), a retired cook-grandmother who knows the truth. Setting seeds: a bustling fish-market city, Twin A's modern tasting-menu kitchen, Twin B's old-family trattoria. Build a 3-chapter slice-of-life with _plan.md, chapter-001.md/chapter-002.md/chapter-003.md, wiki/ with at minimum one character entry, one location entry, one faction/family entry. Expand freely — name the city, invent the prize dish, design the rivalry arc. Zero-padded chapter filenames (.md).",
    workspace: "workspace/twin-chefs",
    summary: "Built workspace/twin-chefs/ — 3 chapters of the rival-chefs saga with wiki/profile entries for each twin, the restaurant, and the estranged family.",
  },
]

function buildEntries(ex: EnvoyExample): ExampleEntry[] {
  const spawnResult = JSON.stringify({
    name: "spawn_agent",
    result: { success: true, data: { summary: ex.summary, sessionId: `${ex.workspace}-sub` } },
  })

  return [
    { type: "user", content: ex.userPrompt },
    {
      type: "think",
      content:
        "I am the envoy, not the writer. My job is to pull seedlings out of the user's request and hand them to a specialist. I should NOT write the story, invent the cast, or pre-build the outline myself — that is the storyteller's job. I only need to (a) extract 2-3 premise seeds the user implied, (b) hint at a cast skeleton and a place skeleton so the subagent knows what world it is building, and (c) keep the instructions tight enough that the subagent has room to expand. The storyteller's instructions demand a _plan.md + 3 zero-padded chapters + a wiki with at minimum a character / location / faction entry — I will restate that in the task so the subagent does not have to reread its instructions.",
    },
    {
      type: "tool_call",
      content: JSON.stringify({
        name: "spawn_agent",
        arguments: { agent: "storyteller", task: ex.task, workspace: ex.workspace },
      }),
    },
    { type: "tool_response", content: spawnResult },
    {
      type: "think",
      content:
        "The subagent finished. I never see its internal state, only the summary it returns. I should report the deliverables — file locations, what was written — without paraphrasing the story itself. The user asked for X; I should confirm X is done and where to find it.",
    },
    { type: "text", content: ex.summary },
  ]
}

export function loadEnvoyExamples(): ExampleEntry[] {
  return EXAMPLES.flatMap(buildEntries)
}
