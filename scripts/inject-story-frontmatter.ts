#!/usr/bin/env node
//
// Add frontmatter-think blocks to all example markdown files under
// src/agents/storyteller/examples/story-*/*.md if missing.
//
// Each think is a file-role narration describing what the model
// should be thinking about WHEN it generates that file's content.
//
// Idempotent: skip files that already begin with `---`.
//
import * as fs from "fs"
import * as path from "path"
import * as url from "url"

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..")
const EXAMPLES_ROOT = path.join(ROOT, "src", "agents", "storyteller", "examples")

const ROLE_HINTS: Record<string, string> = {
  _user: "User-level intent for this story. The model should treat this as the unshaped creative prompt — premise, audience, constructive constraints. Surfacing it here keeps the next think step honest.",
  _plan:        "Plan file. Lock the premise, the chapter beats, and the wiki commitments BEFORE writing prose. The plan is the contract; chapters and wiki obey it.",
  "chapter-001": "Opening chapter. Establish the protagonist, the world they live in, the central conflict, and the inciting incident. End on a hook that pulls the reader into chapter 2.",
  "chapter-002": "Act-two chapter. Deepen the relationship the opening introduced. Escalate stakes. Land on a turn that hands the climax to chapter 3.",
  "chapter-003": "Climax + resolution. Resolve the inciting incident, pay off chapter 2's setup, give every main character a beat. Keep it tight; do not introduce new factions, magic rules, or lore in the final chapter.",
}

const WIKI_HINTS: Record<string, string> = {
  character: "Character wiki entry. Profile should cover appearance, motivation, key relationship, and a single sentence connecting them to the chapter events. The model should keep profiles short and information-dense.",
  location:  "Location wiki entry. Atmosphere + a sensory detail + the threat or opportunity the place presents. Aim for one paragraph a reader can picture.",
  faction:   "Faction wiki entry. Public-facing purpose, the private agenda, leadership, methods — make the antagonist credibly threatening and the ally credibly useful.",
}

function stemHint(stem: string): string | null {
  if (stem.startsWith("chapter-")) return ROLE_HINTS[stem] ?? null
  return ROLE_HINTS[stem] ?? null
}

function categoryHint(filePath: string): string | null {
  const parts = filePath.split(path.sep)
  const idx = parts.indexOf("wiki")
  if (idx < 0 || idx + 1 >= parts.length) return null
  const cat = parts[idx + 1]
  return WIKI_HINTS[cat] ?? null
}

function slugHint(filePath: string): string {
  return path.basename(filePath, ".md")
}

function makeThink(filePath: string, fallbackStem: string): string {
  // Custom dict per story file for richer target narrations.
  const storyCustom: Record<string, string> = {
    "story-shadow/_user.md": "The shadow-realm thief story: a heist gone wrong, cursed shadows spilling into a city. The model should approach this as a moody noir setup with strong physical-sensory grounding.",
    "story-shadow/_plan.md": "Plan tone: noir, slow-burn. The chapters should escalate menace without breaking visual continuity. The wiki covers Mara, the city, and the antagonist — keep that focus.",
    "story-shadow/chapter-001.md": "Chapter 1 voice: third-person, tense prose, present tense if possible. Open inside the heist, mid-action, then ground us in Mara's expertise.",
    "story-shadow/chapter-002.md": "Chapter 2 voice: same tense / POV as chapter 1. The shadow threat should become undeniable to a wider cast. End on a structural turn that cannot be undone.",
    "story-shadow/chapter-003.md": "Chapter 3 voice: climax + bargain. Don't introduce another antagonist. Mara's choice should be the climax. Loop the sense detail you used in chapter 1 — the iron-and-stained-glass-dome — back in as a callback.",
    "story-shadow/wiki/character/mara.md": "Mara is the thief protagonist. Profile what's known publicly, what she's hiding, and the debt that drives her.",
    "story-shadow/wiki/location/duskfall.md": "Duskfall City is the heist town and the spreading-shadow zone. Profile both what the city surfaces show and the threat under the surface.",
    "story-shadow/wiki/faction/umbral-order.md": "The Umbral Order is morally-complicated — night-watch enforcers who secretly bind shadow-eaters. Public function vs private agenda.",

    "story-tale/_user.md": "The dragon-realm story: a blacksmith nurses a dying last-of-her-kind dragon, the Ashen Council closes in. Approach as intimate character study braided with prophecy/moral question.",
    "story-tale/_plan.md": "Plan tone: warm but tense. Each chapter builds toward the dragon's sacrifice. The wiki covers Lyra (dragon), Kael (smith), Dragon's Peak, the Ashen Council.",
    "story-tale/chapter-001.md": "Chapter 1 voice: warm first contact, mountain atmosphere. Show Kael as careful (not heroic) — careful is the tension.",
    "story-tale/chapter-002.md": "Chapter 2 voice: bonding, history. Use the night-by-the-fire element to reveal lore without info-dumping.",
    "story-tale/chapter-003.md": "Chapter 3 voice: climax is Kael's choice, not a battle. Lyra's goodbye is the emotional lever — handle with restraint.",
    "story-tale/wiki/character/lyra.md": "Lyra is the bronze dragon. Last-of-her-kind, weary, protective. Profile what 427 years feels like on her.",
    "story-tale/wiki/location/dragon-peak.md": "Dragon's Peak: high-altitude, summit mist, dragon-carved tunnels, locals half-believing. Profile atmosphere + what the place holds.",
    "story-tale/wiki/faction/ashen-council.md": "Ashen Council: institutional antagonist. Methods (ash-magic, compass trackers, scale bounties) make them feel credible.",

    "story-starfall/_user.md": "The starfall saga: an astronomer notices the falling star's trajectory is wrong, then has to push past her Council to publish. Approach as quiet mystery + institutional politics.",
    "story-starfall/_plan.md": "Plan tone: observational, careful. The chapters should escalate from anomaly to suppressed report to undeniable signal. Wiki covers Celeste, the crater, the Council.",
    "story-starfall/chapter-001.md": "Chapter 1 voice: observatory-detail rich. Open with the nightly skywatching ritual, then the trajectory anomaly.",
    "story-starfall/chapter-002.md": "Chapter 2 voice: expedition atmosphere. The crater's flora + crystals should feel alien-but-familiar.",
    "story-starfall/chapter-003.md": "Chapter 3 voice: institutional battle. Celeste's choice to publish outweighs wins the climax — restraint beat.",
    "story-starfall/wiki/character/celeste.md": "Celeste is the chief astronomer. Quiet obsession with old star maps, a superstition she keeps, friction with her Council. Profile the small-tells.",
    "story-starfall/wiki/location/starfall-crater.md": "Starfall Crater: high-plains impact site, glass-floor depression, strange flora, crystals humming at dawn. Profile atmosphere + that research-leads-the-instruments-astray detail.",
    "story-starfall/wiki/faction/observatory-council.md": "Observatory Council: institutional gatekeepers. Public mission vs private funding-discipline; profile what they suppressed and why.",
  }
  return storyCustom[filePath] ?? fallbackHint(filePath, fallbackStem)
}

function fallbackHint(filePath: string, fallbackStem: string): string {
  const stem = slugHint(filePath)
  const cat = categoryHint(filePath)
  if (cat) return cat
  if (stemHint(stem)) return stemHint(stem)!
  if (ROLE_HINTS[fallbackStem]) return ROLE_HINTS[fallbackStem]
  return `Wiki entry for ${stem}.`
}

function main() {
  let touched = 0
  let skipped = 0
  const errors: string[] = []
  for (const story of fs.readdirSync(EXAMPLES_ROOT)) {
    if (!story.startsWith("story-")) continue
    const storyDir = path.join(EXAMPLES_ROOT, story)
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        const rel = path.relative(EXAMPLES_ROOT, p)
        if (ent.isDirectory()) {
          walk(p)
          continue
        }
        if (!p.endsWith(".md")) continue
        const existing = fs.readFileSync(p, "utf-8")
        if (existing.startsWith("---\n") || existing.startsWith("---\r\n")) {
          skipped++
          continue
        }
        const stem = p.split(path.sep).slice(-1)[0].replace(/\.md$/, "")
        const thinkBody = makeThink(rel.replace(/\\/g, "/"), stem)
        const block = `---\nthink: |\n  ${thinkBody.split("\n").join("\n  ")}\n---\n`
        fs.writeFileSync(p, block + existing, "utf-8")
        touched++
      }
    }
    walk(storyDir)
  }
  console.log(`touched: ${touched}, skipped (already had frontmatter): ${skipped}`)
  if (errors.length) {
    console.error("errors:", errors)
    process.exit(1)
  }
}

main()
