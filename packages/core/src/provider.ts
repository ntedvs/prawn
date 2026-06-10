import { Context, Data, type Stream } from "effect"
import type { Message, StopReason, Usage } from "./message.js"
import type { AnyAgentTool } from "./tool.js"

// Normalized wire events. Each provider adapter's deserializer emits these;
// the loop assembles them into an AssistantMessage. Tool-call input arrives
// as partial JSON string fragments (Anthropic input_json_delta / OpenAI arg
// fragments); adapters for providers that deliver whole calls at once
// (Gemini) synthesize a Start/InputDelta/BlockEnd triplet.
export type ProviderEvent = Data.TaggedEnum<{
  TextDelta: { readonly contentIndex: number; readonly delta: string }
  ThinkingDelta: { readonly contentIndex: number; readonly delta: string }
  ToolCallStart: {
    readonly contentIndex: number
    readonly id: string
    readonly name: string
  }
  ToolCallInputDelta: {
    readonly contentIndex: number
    readonly partialJson: string
  }
  // providerBlob carries an opaque provider payload to round-trip (e.g. an
  // OpenAI reasoning item with encrypted_content); it lands on the block.
  BlockEnd: { readonly contentIndex: number; readonly providerBlob?: unknown }
  Done: { readonly stopReason: StopReason; readonly usage: Usage }
}>
export const ProviderEvent = Data.taggedEnum<ProviderEvent>()

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ProviderClientShape {
  readonly providerId: string
  readonly modelId: string
  readonly streamTurn: (
    history: ReadonlyArray<Message>,
    tools: ReadonlyArray<AnyAgentTool>,
  ) => Stream.Stream<ProviderEvent, ProviderError>
}

export class ProviderClient extends Context.Tag("prawn/ProviderClient")<
  ProviderClient,
  ProviderClientShape
>() {}
