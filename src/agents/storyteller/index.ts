import { promises as fsp } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { RwkvEngine } from "../../engine/rwkv-engine.ts"
import { SessionManager } from "../../core/session.ts"
import { StoryState, ChapterInfo, DEFAULT_GEN_OPTS, GenerateOpts } from "../../core/types.ts"
import { toolsToGbnfResponse } from "../../core/tool-registry.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function cleanOutput(text: string): string {
  return text
    .replace(/^Assistant:\s*/i, "")
    .replace(/\x03/g, "")
    .trim()
}

const RESPONSE_GRAMMAR = toolsToGbnfResponse()

export class StorytellerAgent {
  private engine: RwkvEngine
  private session: SessionManager
  private storyState: StoryState | null = null
  private systemPrompt: string = ""

  constructor(
    engine: RwkvEngine,
    session: SessionManager,
    _config?: { fixParagraphBreak?: boolean },
  ) {
    this.engine = engine
    this.session = session
  }

  async init() {
    this.systemPrompt = await fsp.readFile(
      path.join(__dirname, "instructions.mdx"),
      "utf-8",
    )
    await this.session.ensureDir()
    const sess = await this.session.load()

    if (sess.status === "new") {
      await this.engine.bakeSystemPrompt(this.systemPrompt)
      await this.session.save()
    } else {
      await this.engine.loadBaseline()
    }
  }

  async continueStory(userInput: string, opts: Partial<GenerateOpts> = {}): Promise<string> {
    const sess = this.session.get()
    sess.status = "active"

    const history = this.session.buildPrompt(this.systemPrompt)
    const fullPrompt = history + userInput + "\n\n"

    const raw = await this.engine.generate(fullPrompt, {
      ...DEFAULT_GEN_OPTS,
      temperature: 0.85,
      stopSequences: ["\x03"],
      grammar: RESPONSE_GRAMMAR,
      ...opts,
    })

    const rawStripped = raw.replace(/\x03/g, "")
    const cleaned = cleanOutput(rawStripped)
    this.session.addMessage({ role: "user", content: userInput })
    this.session.addMessage({ role: "assistant", content: rawStripped })
    await this.session.save()

    return cleaned
  }

  async continueStoryStream(
    userInput: string,
    onText: (text: string) => void,
    opts: Partial<GenerateOpts> = {},
  ): Promise<string> {
    const sess = this.session.get()
    sess.status = "active"

    const history = this.session.buildPrompt(this.systemPrompt)
    const fullPrompt = history + userInput + "\n\n"

    const raw = await this.engine.generateStream(
      fullPrompt,
      { onText },
      { ...DEFAULT_GEN_OPTS, temperature: 0.85, stopSequences: ["\x03"], grammar: RESPONSE_GRAMMAR, ...opts },
    )

    const rawStripped = raw.replace(/\x03/g, "")
    const cleaned = cleanOutput(rawStripped)
    this.session.addMessage({ role: "user", content: userInput })
    this.session.addMessage({ role: "assistant", content: rawStripped })
    await this.session.save()

    return cleaned
  }

  async saveChapterCheckpoint(chapterNum: number, slug: string) {
    const name = `chapter_${String(chapterNum).padStart(3, "0")}_${slug}`
    await this.engine.saveCheckpoint(name)
    this.session.registerCheckpoint(name, this.engine.statePath(name))
    await this.session.save()
  }

  async loadChapterCheckpoint(chapterNum: number) {
    const sess = this.session.get()
    const key = Object.keys(sess.statePaths.checkpoints).find(
      (k) => k.startsWith(`chapter_${String(chapterNum).padStart(3, "0")}_`),
    )
    if (!key) {
      await this.engine.loadBaseline()
      return false
    }
    await this.engine.loadCheckpoint(key)
    return true
  }

  async resumeFromBaseline() {
    await this.engine.loadBaseline()
  }

  async dispose() {
    await this.session.save()
    await this.engine.dispose()
  }
}
