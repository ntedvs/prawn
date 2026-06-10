import { produce, type SetStoreFunction } from "solid-js/store"
import { textOf, type AgentEvent, type Message } from "@prawn/core"

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool"
      id: string
      name: string
      args: string
      output: string | undefined
      isError: boolean
      running: boolean
    }

export interface TranscriptState {
  entries: Entry[]
  status: string
}

// Folds the AgentEvent stream into a flat, append-only list of transcript
// entries. blockIndex maps a turn's contentIndex → entries position (reset each
// turn since indices restart); idIndex maps a tool-call id → position (kept
// across turns, since execution events arrive after the turn that emitted them).
export const createTranscript = (setStore: SetStoreFunction<TranscriptState>) => {
  let length = 0
  const blockIndex = new Map<number, number>()
  const idIndex = new Map<string, number>()

  const push = (entry: Entry): number => {
    const at = length
    setStore(produce((state) => void state.entries.push(entry)))
    length += 1
    return at
  }

  const appendText = (at: number, delta: string) =>
    setStore(
      produce((state) => {
        const entry = state.entries[at]
        if (entry && (entry.kind === "assistant" || entry.kind === "thinking")) {
          entry.text += delta
        }
      }),
    )

  const upsertText = (contentIndex: number, kind: "assistant" | "thinking", delta: string) => {
    let at = blockIndex.get(contentIndex)
    if (at === undefined) {
      at = push({ kind, text: "" })
      blockIndex.set(contentIndex, at)
    }
    appendText(at, delta)
  }

  const updateTool = (
    at: number | undefined,
    patch: (entry: Extract<Entry, { kind: "tool" }>) => void,
  ) => {
    if (at === undefined) return
    setStore(
      produce((state) => {
        const entry = state.entries[at]
        if (entry?.kind === "tool") patch(entry)
      }),
    )
  }

  const pushUser = (text: string) => push({ kind: "user", text })

  // Rebuilds entries from a persisted history when resuming a session. Tool
  // results are folded back onto their originating tool entry via idIndex.
  const seed = (messages: ReadonlyArray<Message>) => {
    for (const message of messages) {
      switch (message._tag) {
        case "UserMessage":
          push({ kind: "user", text: textOf(message.blocks) })
          break
        case "AssistantMessage":
          for (const block of message.blocks) {
            if (block._tag === "Thinking") push({ kind: "thinking", text: block.text })
            else if (block._tag === "Text") push({ kind: "assistant", text: block.text })
            else if (block._tag === "ToolCall") {
              const at = push({
                kind: "tool",
                id: block.id,
                name: block.name,
                args: JSON.stringify(block.input),
                output: undefined,
                isError: false,
                running: false,
              })
              idIndex.set(block.id, at)
            }
          }
          break
        case "ToolResultMessage":
          updateTool(idIndex.get(message.toolCallId), (e) => {
            e.isError = message.isError
            e.output = textOf(message.blocks)
          })
          break
      }
    }
  }

  const apply = (event: AgentEvent) => {
    switch (event._tag) {
      case "TurnStart":
        blockIndex.clear()
        setStore("status", "thinking…")
        break
      case "ThinkingDelta":
        upsertText(event.contentIndex, "thinking", event.delta)
        break
      case "TextDelta":
        upsertText(event.contentIndex, "assistant", event.delta)
        break
      case "ToolCallStart": {
        const at = push({
          kind: "tool",
          id: event.id,
          name: event.name,
          args: "",
          output: undefined,
          isError: false,
          running: false,
        })
        blockIndex.set(event.contentIndex, at)
        idIndex.set(event.id, at)
        break
      }
      case "ToolCallDelta":
        updateTool(blockIndex.get(event.contentIndex), (e) => {
          e.args = JSON.stringify(event.partialInput)
        })
        break
      case "ToolCallEnd":
        updateTool(blockIndex.get(event.contentIndex), (e) => {
          e.args = JSON.stringify(event.input)
        })
        break
      case "ToolExecutionStart":
        setStore("status", `running ${event.name}…`)
        updateTool(idIndex.get(event.id), (e) => {
          e.running = true
        })
        break
      case "ToolExecutionEnd":
        updateTool(idIndex.get(event.id), (e) => {
          e.running = false
          e.isError = event.isError
          e.output = event.output
        })
        break
      case "AgentEnd":
        setStore("status", "idle")
        break
      default:
        break
    }
  }

  return { pushUser, apply, seed }
}
