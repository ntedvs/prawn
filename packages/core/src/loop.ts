import { Effect, Schema, Stream } from "effect"
import { parse as parsePartialJson } from "partial-json"
import { AgentEvent } from "./events.js"
import {
  AssistantMessage,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  toolCallsOf,
  type ContentBlock,
  type StopReason,
  type ToolCallBlock as ToolCall,
  type Usage,
  type UserMessage,
} from "./message.js"
import { ProviderClient, type ProviderError } from "./provider.js"
import { ToolRegistry } from "./tool.js"
import { EventBus, SessionStore, Steering } from "./services.js"

interface BlockAccumulator {
  readonly kind: "text" | "thinking" | "toolCall"
  text: string
  json: string
  id: string
  name: string
  providerBlob?: unknown
}

// Consume the provider's event stream, publishing deltas to the EventBus
// while folding events into a complete AssistantMessage.
const streamAssistantResponse: Effect.Effect<
  AssistantMessage,
  ProviderError,
  ProviderClient | ToolRegistry | EventBus | SessionStore
> = Effect.gen(function* () {
  const provider = yield* ProviderClient
  const registry = yield* ToolRegistry
  const bus = yield* EventBus
  const store = yield* SessionStore
  const history = yield* store.history

  const accumulators = new Map<number, BlockAccumulator>()
  let stopReason: StopReason = "endTurn"
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }

  const accumulator = (index: number, kind: BlockAccumulator["kind"]): BlockAccumulator => {
    let acc = accumulators.get(index)
    if (!acc) {
      acc = { kind, text: "", json: "", id: "", name: "" }
      accumulators.set(index, acc)
    }
    return acc
  }

  yield* provider.streamTurn(history, registry.all).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "TextDelta": {
            accumulator(event.contentIndex, "text").text += event.delta
            yield* bus.publish(
              AgentEvent.TextDelta({ contentIndex: event.contentIndex, delta: event.delta }),
            )
            break
          }
          case "ThinkingDelta": {
            accumulator(event.contentIndex, "thinking").text += event.delta
            yield* bus.publish(
              AgentEvent.ThinkingDelta({ contentIndex: event.contentIndex, delta: event.delta }),
            )
            break
          }
          case "ToolCallStart": {
            const acc = accumulator(event.contentIndex, "toolCall")
            acc.id = event.id
            acc.name = event.name
            yield* bus.publish(
              AgentEvent.ToolCallStart({
                contentIndex: event.contentIndex,
                id: event.id,
                name: event.name,
              }),
            )
            break
          }
          case "ToolCallInputDelta": {
            const acc = accumulator(event.contentIndex, "toolCall")
            acc.json += event.partialJson
            yield* bus.publish(
              AgentEvent.ToolCallDelta({
                contentIndex: event.contentIndex,
                id: acc.id,
                partialInput: bestEffortJson(acc.json),
              }),
            )
            break
          }
          case "BlockEnd": {
            // A blob with no prior deltas still needs a block (e.g. an OpenAI
            // reasoning item whose summary was empty).
            const acc =
              event.providerBlob !== undefined
                ? accumulator(event.contentIndex, "thinking")
                : accumulators.get(event.contentIndex)
            if (acc && event.providerBlob !== undefined) {
              acc.providerBlob = event.providerBlob
            }
            if (acc?.kind === "toolCall") {
              yield* bus.publish(
                AgentEvent.ToolCallEnd({
                  contentIndex: event.contentIndex,
                  id: acc.id,
                  name: acc.name,
                  input: bestEffortJson(acc.json),
                }),
              )
            }
            break
          }
          case "Done": {
            stopReason = event.stopReason
            usage = event.usage
            yield* bus.publish(AgentEvent.AssistantDone({ stopReason, usage }))
            break
          }
        }
      }),
    ),
  )

  const blocks: ContentBlock[] = [...accumulators.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) =>
      acc.kind === "text"
        ? TextBlock.make({ text: acc.text })
        : acc.kind === "thinking"
          ? ThinkingBlock.make({ text: acc.text, providerBlob: acc.providerBlob })
          : ToolCallBlock.make({ id: acc.id, name: acc.name, input: bestEffortJson(acc.json) }),
    )

  return AssistantMessage.make({
    blocks,
    stopReason,
    usage,
    provenance: { providerId: provider.providerId, modelId: provider.modelId },
  })
})

const bestEffortJson = (json: string): unknown => {
  if (json === "") return {}
  try {
    return parsePartialJson(json)
  } catch {
    return {}
  }
}

const executeToolCall = (call: ToolCall) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry
    const bus = yield* EventBus
    yield* bus.publish(
      AgentEvent.ToolExecutionStart({ id: call.id, name: call.name, input: call.input }),
    )
    const output = yield* registry.lookup(call.name).pipe(
      Effect.flatMap((tool) =>
        Schema.decodeUnknown(tool.params)(call.input).pipe(
          Effect.mapError((error) => ({ message: `invalid input: ${error.message}` })),
          Effect.flatMap((input) => tool.execute(input)),
        ),
      ),
      Effect.map((text) => ({ text, isError: false })),
      Effect.catchAll((error) =>
        Effect.succeed({
          text: "message" in error ? error.message : `unknown tool: ${call.name}`,
          isError: true,
        }),
      ),
    )
    yield* bus.publish(
      AgentEvent.ToolExecutionEnd({
        id: call.id,
        name: call.name,
        isError: output.isError,
        output: output.text,
      }),
    )
    return ToolResultMessage.make({
      toolCallId: call.id,
      toolName: call.name,
      blocks: [TextBlock.make({ text: output.text })],
      isError: output.isError,
    })
  })

// Claude Code's dispatch rule: readonly calls run concurrently, mutating ones
// sequentially; unknown tools are treated as mutating (fail closed). Results
// are re-sorted to call order before entering history.
const executeToolCalls = (calls: ReadonlyArray<ToolCall>) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry
    const indexed = calls.map((call, index) => ({ call, index }))
    const isReadonly = (name: string) =>
      registry.all.find((tool) => tool.name === name)?.readonly === true
    const readonlyCalls = indexed.filter(({ call }) => isReadonly(call.name))
    const mutatingCalls = indexed.filter(({ call }) => !isReadonly(call.name))

    const run = ({ call, index }: { call: ToolCall; index: number }) =>
      executeToolCall(call).pipe(Effect.map((result) => ({ result, index })))

    const concurrent = yield* Effect.forEach(readonlyCalls, run, { concurrency: 8 })
    const sequential = yield* Effect.forEach(mutatingCalls, run)
    return [...concurrent, ...sequential]
      .sort((a, b) => a.index - b.index)
      .map(({ result }) => result)
  })

// On interruption mid-tool-execution the assistant message (carrying tool_use
// blocks) is already in history, but its results are not — an orphaned tool_use
// that strict providers (Anthropic) reject on resume. This back-fills a synthetic
// aborted result for every call still missing one, keeping history well-formed.
const finalizeInterruptedTools = (calls: ReadonlyArray<ToolCall>) =>
  Effect.gen(function* () {
    const store = yield* SessionStore
    const bus = yield* EventBus
    const history = yield* store.history
    const resolved = new Set(
      history
        .filter((m): m is ToolResultMessage => m._tag === "ToolResultMessage")
        .map((m) => m.toolCallId),
    )
    const missing = calls.filter((call) => !resolved.has(call.id))
    yield* Effect.forEach(missing, (call) =>
      Effect.gen(function* () {
        yield* bus.publish(
          AgentEvent.ToolExecutionEnd({
            id: call.id,
            name: call.name,
            isError: true,
            output: "Aborted by user.",
          }),
        )
        yield* store.append(
          ToolResultMessage.make({
            toolCallId: call.id,
            toolName: call.name,
            blocks: [TextBlock.make({ text: "Aborted by user." })],
            isError: true,
          }),
        )
      }),
    )
    yield* bus.publish(AgentEvent.AgentEnd())
  })

export const runAgent = (initial: UserMessage) =>
  Effect.gen(function* () {
    const bus = yield* EventBus
    const store = yield* SessionStore
    const steering = yield* Steering
    yield* store.append(initial)

    while (true) {
      const steered = yield* steering.drain
      yield* Effect.forEach(steered, store.append)

      yield* bus.publish(AgentEvent.TurnStart())
      const assistant = yield* streamAssistantResponse
      yield* store.append(assistant)
      yield* bus.publish(AgentEvent.TurnEnd())

      if (assistant.stopReason !== "toolUse") break

      const calls = toolCallsOf(assistant)
      yield* executeToolCalls(calls).pipe(
        Effect.flatMap((results) => Effect.forEach(results, store.append)),
        // Finalizer runs uninterruptibly during teardown, so the synthetic
        // aborted results are persisted even as the fiber unwinds.
        Effect.onInterrupt(() => finalizeInterruptedTools(calls)),
      )
    }

    yield* bus.publish(AgentEvent.AgentEnd())
  })
