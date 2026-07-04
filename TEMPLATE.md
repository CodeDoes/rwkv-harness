ToolResponseBlock 
```
ProseInner = ("\n\t" ProseLine)*

SystemBlock = "System:" + ProseInner
UserBlock = "User:\n\t" + ProseInner
ToolResponseBlock = "User:\n\t" "<tool_reponse>" "\n\t</tool_response>

AssistantBlock = "Assistant:\n\t" + AssistantContent
AssistantContent = ThinkSection | ToolCallSection | TextSection
ThinkSection = "<think>" ProseInner "</think>"
ToolCallSection = "<tool_call>" ProseInner "</tool_call>"
TextSection = ProseInner

Block =(SystemBlock | UserBlock | AssistantBlock)
Document = (Block ("\n\n" Block)*)? 
```

ToolResponseInline 
```
ProseInner = ("\n\t" ProseLine)*

SystemBlock = "System:" + ProseInner
UserBlock = "User:\n\t" + ProseInner

AssistantBlock = "Assistant:\n\t" + AssistantContent
AssistantContent = ThinkSection | ToolCallSection | TextSection
ThinkSection = "<think>" ProseInner "</think>"
ToolCallSection = "<tool_call>" ProseInner "</tool_call>"
TextSection = ProseInner

Block =(SystemBlock | UserBlock | AssistantBlock)
Context = (Block ("\n\n" Block)*)? 
```
