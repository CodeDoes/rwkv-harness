import { ToolDef, ToolHandler } from "../../../types.ts"

export const toolDefs: ToolDef[] = [
  {
    name: "spawn_agent",
    description: "Delegate a task to a specialized subagent. The agent runs autonomously. Returns a summary of what was done.",
    parameters: [
      { name: "agent", type: "string", description: "Agent to spawn: storyteller, coder", required: true, enum: ["storyteller", "coder"] },
      { name: "task", type: "string", description: "Full task description including requirements and file paths", required: true },
      { name: "workspace", type: "string", description: "Directory path for the agent to work in", required: false },
    ],
  },
]

export const toolHandlers: Record<string, ToolHandler> = {
  spawn_agent: (args) => {
    return { spawned: args.agent as string, task: args.task as string, status: "pending" }
  },
}

export function toolsToXml(): string {
  return toolDefs.map((t) => {
    const params = t.parameters.map((p) =>
      `  <parameter name="${p.name}" type="${p.type}"${p.required ? " required=\"true\"" : ""}${p.enum ? ` enum="${p.enum.join(",")}"` : ""}>${p.description}</parameter>`
    ).join("\n")
    return `<tool name="${t.name}" description="${t.description}">\n${params}\n</tool>`
  }).join("\n\n")
}
