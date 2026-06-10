import { Data } from "effect"
import type { StopReason, Usage } from "./message.js"

// The single contract between the agent loop and any frontend (TUI, print
// mode, RPC). Deltas are keyed by contentIndex because blocks can interleave.
export type AgentEvent = Data.TaggedEnum<{
  TurnStart: {}
  TextDelta: { readonly contentIndex: number; readonly delta: string }
  ThinkingDelta: { readonly contentIndex: number; readonly delta: string }
  ToolCallStart: {
    readonly contentIndex: number
    readonly id: string
    readonly name: string
  }
  // partialInput is a best-effort parse of the incomplete JSON — fields may be
  // truncated, but it is never undefined once the first delta arrives.
  ToolCallDelta: {
    readonly contentIndex: number
    readonly id: string
    readonly partialInput: unknown
  }
  ToolCallEnd: {
    readonly contentIndex: number
    readonly id: string
    readonly name: string
    readonly input: unknown
  }
  ToolExecutionStart: {
    readonly id: string
    readonly name: string
    readonly input: unknown
  }
  ToolExecutionEnd: {
    readonly id: string
    readonly name: string
    readonly isError: boolean
    readonly output: string
  }
  AssistantDone: { readonly stopReason: StopReason; readonly usage: Usage }
  TurnEnd: {}
  AgentEnd: {}
}>
export const AgentEvent = Data.taggedEnum<AgentEvent>()
