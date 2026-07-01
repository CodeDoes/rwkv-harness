import { z } from "zod"

export type JsonSchema = {
  type?: string
  enum?: string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
}

export function zodToJson(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const props: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [key, val] of Object.entries(shape)) {
      props[key] = zodToJson(val)
      if (!(val instanceof z.ZodOptional)) {
        required.push(key)
      }
    }
    return { type: "object", properties: props, required }
  }

  if (schema instanceof z.ZodString) {
    return { type: "string" }
  }

  if (schema instanceof z.ZodNumber) {
    return { type: "number" }
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" }
  }

  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: (schema as any)._def.values as string[] }
  }

  if (schema instanceof z.ZodOptional) {
    return zodToJson(schema.unwrap() as z.ZodTypeAny)
  }

  // Fallback
  return { type: "string" }
}
