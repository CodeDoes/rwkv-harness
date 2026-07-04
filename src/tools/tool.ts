import { z } from "zod"
import type { ToolDef, ToolHandler } from "../types.ts"

/**
 * Tool — single class unifying declaration, validation, execution, and grammar
 * generation. See ARCH.md §"Tool" (A9, A10).
 */
export class Tool<In extends z.ZodTypeAny = z.ZodTypeAny, Out extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string
  readonly description: string
  readonly input_schema: z.ZodTypeAny
  readonly output_schema: z.ZodTypeAny
  private readonly _exec: (args: unknown) => Promise<unknown> | unknown

  constructor(opts: {
    name: string
    description: string
    input_schema: In
    output_schema?: Out
    exec: (args: z.infer<In>) => Promise<z.infer<Out>> | z.infer<Out>
  }) {
    this.name = opts.name
    this.description = opts.description
    this.input_schema = opts.input_schema
    this.output_schema = opts.output_schema ?? z.any()
    this._exec = opts.exec as (args: unknown) => Promise<unknown> | unknown
  }

  /** Validate and execute. Throws on invalid input. */
  async exec(args: unknown): Promise<unknown> {
    const parsed = this.input_schema.parse(args)
    return this._exec(parsed)
  }

  /** Per-tool GBNF fragment: a rule that matches `<tool_call>\n\t{…}\n\t</tool_call>`. */
  grammar(): string {
    const safe = this.name.replace(/_/g, "")
    const paramsLines = this.buildParamRules()

    return [
      // name rule
      `${safe}name ::= "\\"name\\"" ws ":" ws "\\"${this.name}\\""`,
      // args rule — wraps all params
      `${safe}args ::= "\\"arguments\\"" ws ":" ws "{" ws ${paramsLines.join(` ws "," ws `)} ws "}"`,
      // full call rule
      `${safe}call ::= "\\t" "<tool_call>" "\\n" "\\t" "{" ws ${safe}name ws "," ws ${safe}args ws "}" "\\n" "\\t" "</tool_call>"`,
    ].join("\n")
  }

  /** The call rule name (e.g. `callread`, `callwrite`). Used by the root grammar assembler. */
  get callRuleName(): string {
    return `call${this.name.replace(/_/g, "")}`
  }

  private buildParamRules(): string[] {
    const shape = (this.input_schema instanceof z.ZodObject) ? (this.input_schema as z.ZodObject<any>).shape : {}
    return Object.entries(shape).map(([key, _schema]) => {
      const gbnfType = this.inferGbnfType(_schema as z.ZodTypeAny)
      return `"\\"${key}\\"" ws ":" ws ${gbnfType}`
    })
  }

  private inferGbnfType(schema: z.ZodTypeAny): string {
    if (schema instanceof z.ZodString) return "string-value"
    if (schema instanceof z.ZodNumber) return "number-value"
    if (schema instanceof z.ZodBoolean) return "boolean-value"
    if (schema instanceof z.ZodEnum) {
      const values = (schema._def as any).values as string[]
      return `(${values.map((v) => `"\\"${v}\\""`).join(" | ")})`
    }
    if (schema instanceof z.ZodOptional) return this.inferGbnfType(schema.unwrap() as z.ZodTypeAny)
    return "string-value" // fallback
  }

  /** Convert back to legacy ToolDef for compat with existing grammar builders. */
  toLegacyDef(): ToolDef {
    const shape = (this.input_schema instanceof z.ZodObject) ? (this.input_schema as z.ZodObject<any>).shape : {}
    const defs: ToolDef = {
      name: this.name,
      description: this.description,
      parameters: (Object.entries(shape) as Array<[string, z.ZodTypeAny]>).map(([key, s]) => {
        const schema = s instanceof z.ZodOptional ? s.unwrap() as z.ZodTypeAny : s
        const isOptional = s instanceof z.ZodOptional
        let type: "string" | "number" | "boolean" = "string"
        if (schema instanceof z.ZodNumber) type = "number"
        else if (schema instanceof z.ZodBoolean) type = "boolean"
        return {
          name: key,
          type,
          description: (schema as any).description ?? key,
          required: !isOptional,
        }
      }),
    }
    return defs
  }

  /** Wrap an old-style `(ToolDef, ToolHandler)` pair into a `Tool`. */
  static fromLegacy(def: ToolDef, handler: ToolHandler): Tool {
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const p of def.parameters) {
      let s: z.ZodTypeAny
      if (p.type === "number") s = z.number()
      else if (p.type === "boolean") s = z.boolean()
      else if (p.enum) s = z.enum(p.enum as [string, ...string[]])
      else s = z.string()
      if (p.description) s = s.describe(p.description)
      if (!p.required) s = s.optional()
      shape[p.name] = s
    }
    const schema = def.schema ?? z.object(shape)
    return new Tool({
      name: def.name,
      description: def.description,
      input_schema: schema,
      exec: (args: unknown) => handler(args as Record<string, unknown>),
    })
  }
}
