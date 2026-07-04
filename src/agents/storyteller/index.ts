import { promises as fsp } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import type { Engine } from "../../types.ts"
import { SessionManager } from "../../session/session-manager.ts"
import { StoryState, ChapterInfo, DEFAULT_GEN_OPTS, GenerateOpts } from "../../types.ts"
import { toolsToGbnfResponse } from "../../tools/registry.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function cleanOutput(text: string): string {
  return text
    .replace(/^Assistant:\s*/i, "")
    .replace(/\x03/g, "")
    .trim()
}

const RESPONSE_GRAMMAR = toolsToGbnfResponse()

export class StorytellerAgent {
  private model: Engine
  private session: SessionManager
  private storyState: StoryState | null = null
  private systemPrompt: string = ""

  constructor(
    model: Engine,
    session: SessionManager,
    _config?: { fixParagraphBreak?: boolean },
  ) {
    this.model = model
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
      await this.model.bakeSystemPrompt(this.systemPrompt)
      await this.session.save()
    } else {
      await this.model.loadBaseline()
    }
  }

  async continueStory(userInput: string, opts: Partial<GenerateOpts> = {}): Promise<string> {
    const sess = this.session.get()
    sess.status = "active"

    const history = this.session.buildPrompt(this.systemPrompt)
    const fullPrompt = history + userInput + "\n\n"

    const { sessionId } = await this.model.process({ systemPrompt: this.systemPrompt })
    const result = await this.model.generate({
      sessionId,
      prompt: fullPrompt,
      opts: {
        ...DEFAULT_GEN_OPTS,
        temperature: 0.85,
        stopSequences: ["\x03"],
        grammar: RESPONSE_GRAMMAR,
        ...opts,
      },
    })
    await this.model.interrupt(sessionId)

    const rawStripped = result.text.replace(/\x03/g, "")
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

    const { sessionId } = await this.model.process({ systemPrompt: this.systemPrompt })
    const result = await this.model.streamGenerate({
      sessionId,
      prompt: fullPrompt,
      opts: {
        ...DEFAULT_GEN_OPTS,
        temperature: 0.85,
        stopSequences: ["\x03"],
        grammar: RESPONSE_GRAMMAR,
        ...opts,
      },
      onToken: onText,
    })
    await this.model.interrupt(sessionId)

    const rawStripped = result.text.replace(/\x03/g, "")
    const cleaned = cleanOutput(rawStripped)
    this.session.addMessage({ role: "user", content: userInput })
    this.session.addMessage({ role: "assistant", content: rawStripped })
    await this.session.save()

    return cleaned
  }

  async saveChapterCheckpoint(chapterNum: number, slug: string) {
    const name = `chapter_${String(chapterNum).padStart(3, "0")}_${slug}`
    await this.model.saveCheckpoint(name)
    this.session.registerCheckpoint(name, this.model.statePath(name))
    await this.session.save()
  }

  async loadChapterCheckpoint(chapterNum: number) {
    const sess = this.session.get()
    const key = Object.keys(sess.statePaths.checkpoints).find(
      (k) => k.startsWith(`chapter_${String(chapterNum).padStart(3, "0")}_`),
    )
    if (!key) {
      await this.model.loadBaseline()
      return false
    }
    await this.model.loadCheckpoint(key)
    return true
  }

  async resumeFromBaseline() {
    await this.model.loadBaseline()
  }

  async dispose() {
    await this.session.save()
    await this.model.dispose()
  }
}
