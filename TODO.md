# TODO 
## src/eval/.traces/2026-07-03T23-14-49-999Z_oracle.txt is wrong
Tool Response from out of no where? I do not see a tool call. Eval should be hooked into 

## pnpm eval:live still instantly exits src/eval/.traces/2026-07-04T00-28-16-166Z_live.txt

## My mental model of the architecture


InferenceClient.generate({cacheId:string, bnf?:string, stop_sequence: string[],max_tokens?: number= 500 }) -> {cacheId:string, output:string}
InferenceClient.stream({cacheId:string, bnf?:string, stop_sequence: string[],max_tokens?: number= 500 }) -> SSE<{chunk:string}>
InferenceClient.stop({cacheId:string}) -> {stopped:true}
InferenceClient.start() -> {cacheId: string}
InferenceClient.get({cacheId: string}) -> {found: boolean}
InferenceClient.input({cacheId:string, input:string}) -> {cacheId:string}


InferenceServerControl.is_running()
InferenceServerControl.start()
InferenceServerControl.restart()
InferenceServerControl.stop()

Engine.inference_client: InferenceClient
Engine.inference_server_control: InferenceServerControl

MessagePart = {type:"system_instruction"|"user_message"|"think"|"text",content:string}|{type:"tool_call"|"tool_response", data:Record<string, any>}

Tool.input_schema: Schema
Tool.output_schema: Schema
Tool.exec() -> any

BnfGenerator.tool_call_schema(tool: Tool)
BnfGenerator.agent_response_schema(agent: Agent)

Tools: Record<string, Tool>

createMessagePartTemplate() -> MessagePartTemplate

ResponseTemplate = createResponseTemplate({
  system: createMessagePartTemplate({start:"System:\n\t", newline:"\n\t", end:"\n\n"}),
  user: createMessagePartTemplate({start:"User:\n\t", newline:"\n\t", end:"\n\n"}),
  assistant: createMessagePartTemplate({start:"Assistant:\n\t", newline:"\n\t", end:"\n\n"}),
  tool_call: createMessagePartTemplate({start:"<tool_call>", newline:"\n\t", end:"</tool_call>"}),
  tool_response: createMessagePartTemplate({start:"\n\nUser: <tool_response>\n\t", newline:"\n\t", end:"</tool_response>\n\nAssistant:\n\t"}),
})

Agent.tools: Tools
Agent.instructions: string
Agent.state_tune_examples: {[name:string]: MessagePart[]}
Agent.template: ResponseTemplate
Agent.generate_bnf(): string

AgentRegistry.agents: Record<string, Agent>

ResponseStatus = "message_incomplete" | "message_complete"

Session.agent: Agent
Session.cacheId: string
Session.context: MessagePart[]
<!-- session.input(userMessage); session.input(botMessageInit); session.resume(); -->
Session.input(message:Message) 
Session.resume()
Session.child_sessions: Session[]
Session.stop()
