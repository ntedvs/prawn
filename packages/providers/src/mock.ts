import { Effect, Layer, Stream } from "effect"
import { ProviderClient, ProviderEvent, type Message } from "@prawn/core"

// Scripted model: first call requests a bash tool call (streaming the input
// as partial-JSON fragments, like Anthropic's input_json_delta); after it
// sees a tool result in history, it streams a closing text message.
const toolCallTurn: ReadonlyArray<ProviderEvent> = [
  ProviderEvent.ThinkingDelta({ contentIndex: 0, delta: "User wants me to run a command. " }),
  ProviderEvent.ThinkingDelta({ contentIndex: 0, delta: "I'll use bash." }),
  ProviderEvent.BlockEnd({ contentIndex: 0 }),
  ProviderEvent.ToolCallStart({ contentIndex: 1, id: "toolu_mock_001", name: "bash" }),
  ProviderEvent.ToolCallInputDelta({ contentIndex: 1, partialJson: '{"comm' }),
  ProviderEvent.ToolCallInputDelta({ contentIndex: 1, partialJson: 'and": "echo hel' }),
  ProviderEvent.ToolCallInputDelta({ contentIndex: 1, partialJson: 'lo from prawn"}' }),
  ProviderEvent.BlockEnd({ contentIndex: 1 }),
  ProviderEvent.Done({
    stopReason: "toolUse",
    usage: { inputTokens: 120, outputTokens: 30 },
  }),
]

const finalTurn = (toolOutput: string): ReadonlyArray<ProviderEvent> => [
  ProviderEvent.TextDelta({ contentIndex: 0, delta: "The command ran " }),
  ProviderEvent.TextDelta({ contentIndex: 0, delta: "successfully and printed: " }),
  ProviderEvent.TextDelta({ contentIndex: 0, delta: toolOutput.trim() }),
  ProviderEvent.BlockEnd({ contentIndex: 0 }),
  ProviderEvent.Done({
    stopReason: "endTurn",
    usage: { inputTokens: 180, outputTokens: 15 },
  }),
]

const lastToolResult = (history: ReadonlyArray<Message>) =>
  [...history].reverse().find((message) => message._tag === "ToolResultMessage")

export const mockProviderLayer = Layer.succeed(ProviderClient, {
  providerId: "mock",
  modelId: "mock-1",
  streamTurn: (history) => {
    const result = lastToolResult(history)
    const events = result
      ? finalTurn(result.blocks[0]?._tag === "Text" ? result.blocks[0].text : "")
      : toolCallTurn
    return Stream.fromIterable(events).pipe(
      Stream.mapEffect((event) => Effect.sleep("30 millis").pipe(Effect.as(event))),
    )
  },
})
