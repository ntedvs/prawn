import { JSONSchema } from "effect"
import { textOf, type AnyAgentTool, type Message } from "@prawn/core"

// Serialize internal messages into Responses API input items. Thinking blocks
// are replayed verbatim (the raw reasoning item stored in providerBlob) only
// when the history entry came from the same provider; foreign thinking is
// dropped — reasoning continuity is provider-locked.
export const toInputItems = (
  history: ReadonlyArray<Message>,
  providerId: string,
): Array<Record<string, unknown>> => {
  const items: Array<Record<string, unknown>> = []
  for (const message of history) {
    switch (message._tag) {
      case "UserMessage": {
        items.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: textOf(message.blocks) }],
        })
        break
      }
      case "AssistantMessage": {
        const sameProvider = message.provenance.providerId === providerId
        for (const block of message.blocks) {
          switch (block._tag) {
            case "Text": {
              if (block.text !== "") {
                items.push({
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: block.text }],
                })
              }
              break
            }
            case "Thinking": {
              if (sameProvider && block.providerBlob !== undefined) {
                items.push(block.providerBlob as Record<string, unknown>)
              }
              break
            }
            case "ToolCall": {
              items.push({
                type: "function_call",
                call_id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.input),
              })
              break
            }
          }
        }
        break
      }
      case "ToolResultMessage": {
        items.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: textOf(message.blocks),
        })
        break
      }
    }
  }
  return items
}

export const toToolDefinitions = (
  tools: ReadonlyArray<AnyAgentTool>,
): Array<Record<string, unknown>> =>
  tools.map((tool) => {
    const fromEffect = JSONSchema.make(tool.params) as unknown as Record<string, unknown>
    const { $schema: _, ...parameters } = tool.jsonSchema ?? fromEffect
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      strict: false,
    }
  })
