import { Schema } from "effect"

// Content blocks — Anthropic-shaped superset. `providerBlob` on Thinking holds
// the opaque provider payload (Anthropic signature, OpenAI encrypted_content,
// Gemini thoughtSignature) that must be replayed verbatim to the same provider.
export const TextBlock = Schema.TaggedStruct("Text", {
  text: Schema.String,
})
export type TextBlock = typeof TextBlock.Type

export const ThinkingBlock = Schema.TaggedStruct("Thinking", {
  text: Schema.String,
  providerBlob: Schema.optional(Schema.Unknown),
})
export type ThinkingBlock = typeof ThinkingBlock.Type

export const ToolCallBlock = Schema.TaggedStruct("ToolCall", {
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
})
export type ToolCallBlock = typeof ToolCallBlock.Type

export const ContentBlock = Schema.Union(TextBlock, ThinkingBlock, ToolCallBlock)
export type ContentBlock = typeof ContentBlock.Type

export const StopReason = Schema.Literal("endTurn", "toolUse", "maxTokens", "aborted", "error")
export type StopReason = typeof StopReason.Type

export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
})
export type Usage = typeof Usage.Type

export const Provenance = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
})
export type Provenance = typeof Provenance.Type

export const UserMessage = Schema.TaggedStruct("UserMessage", {
  blocks: Schema.Array(ContentBlock),
})
export type UserMessage = typeof UserMessage.Type

export const AssistantMessage = Schema.TaggedStruct("AssistantMessage", {
  blocks: Schema.Array(ContentBlock),
  stopReason: StopReason,
  usage: Usage,
  provenance: Provenance,
})
export type AssistantMessage = typeof AssistantMessage.Type

export const ToolResultMessage = Schema.TaggedStruct("ToolResultMessage", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  blocks: Schema.Array(ContentBlock),
  isError: Schema.Boolean,
})
export type ToolResultMessage = typeof ToolResultMessage.Type

export const Message = Schema.Union(UserMessage, AssistantMessage, ToolResultMessage)
export type Message = typeof Message.Type

export const userText = (text: string): UserMessage =>
  UserMessage.make({ blocks: [TextBlock.make({ text })] })

export const toolCallsOf = (message: AssistantMessage): ReadonlyArray<ToolCallBlock> =>
  message.blocks.filter((block): block is ToolCallBlock => block._tag === "ToolCall")

export const textOf = (blocks: ReadonlyArray<ContentBlock>): string =>
  blocks
    .filter((block): block is TextBlock => block._tag === "Text")
    .map((block) => block.text)
    .join("")
