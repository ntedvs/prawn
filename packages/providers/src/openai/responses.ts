import { Effect, Option, Stream } from "effect"
import {
  ProviderError,
  ProviderEvent,
  type AnyAgentTool,
  type Message,
  type ProviderClientShape,
  type StopReason,
  type Usage,
} from "@prawn/core"
import { toInputItems, toToolDefinitions } from "./serialize.js"

export interface ResponsesConfig {
  readonly providerId: string
  readonly modelId: string
  readonly url: string
  // Effectful so auth can refresh tokens before each request.
  readonly headers: Effect.Effect<Record<string, string>, ProviderError>
  readonly instructions: string
  readonly reasoning?: { readonly effort?: string; readonly summary?: string }
  readonly extraBody?: Record<string, unknown>
}

export const makeResponsesClient = (config: ResponsesConfig): ProviderClientShape => ({
  providerId: config.providerId,
  modelId: config.modelId,
  streamTurn: (history, tools) =>
    request(config, history, tools).pipe(
      Effect.map((body) => {
        const handle = toProviderEvents()
        return body.pipe(
          sseJsonEvents,
          Stream.flatMap((event) => {
            const out = handle(event)
            return out instanceof ProviderError ? Stream.fail(out) : Stream.fromIterable(out)
          }),
        )
      }),
      Stream.unwrap,
    ),
})

const request = (
  config: ResponsesConfig,
  history: ReadonlyArray<Message>,
  tools: ReadonlyArray<AnyAgentTool>,
) =>
  Effect.gen(function* () {
    const headers = yield* config.headers
    const body = {
      model: config.modelId,
      instructions: config.instructions,
      input: toInputItems(history, config.providerId),
      tools: toToolDefinitions(tools),
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      parallel_tool_calls: true,
      ...(config.reasoning ? { reasoning: config.reasoning } : {}),
      ...config.extraBody,
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(config.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      catch: (cause) => new ProviderError({ message: `request failed: ${String(cause)}`, cause }),
    })
    if (!response.ok || response.body === null) {
      const text = yield* Effect.promise(() => response.text().catch(() => ""))
      return yield* new ProviderError({
        message: `HTTP ${response.status}: ${text.slice(0, 2000)}`,
      })
    }
    return Stream.fromReadableStream(
      () => response.body!,
      (cause) => new ProviderError({ message: `stream failed: ${String(cause)}`, cause }),
    )
  })

// Raw bytes → parsed `data:` JSON payloads. OpenAI mirrors the SSE event name
// in the payload's `type` field, so event lines can be ignored.
const sseJsonEvents = (
  bytes: Stream.Stream<Uint8Array, ProviderError>,
): Stream.Stream<any, ProviderError> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filterMap((line) => {
      if (!line.startsWith("data:")) return Option.none()
      const data = line.slice(5).trim()
      if (data === "" || data === "[DONE]") return Option.none()
      try {
        return Option.some(JSON.parse(data))
      } catch {
        return Option.none()
      }
    }),
  )

// Responses SSE → normalized ProviderEvents. output_index keys contentIndex.
const toProviderEvents = () => {
  let sawToolCall = false
  return (event: any): Array<ProviderEvent> | ProviderError => {
    switch (event.type) {
      case "response.output_item.added": {
        if (event.item?.type === "function_call") {
          sawToolCall = true
          return [
            ProviderEvent.ToolCallStart({
              contentIndex: event.output_index,
              id: event.item.call_id,
              name: event.item.name,
            }),
          ]
        }
        return []
      }
      case "response.output_text.delta":
        return [ProviderEvent.TextDelta({ contentIndex: event.output_index, delta: event.delta })]
      case "response.reasoning_summary_text.delta":
        return [
          ProviderEvent.ThinkingDelta({ contentIndex: event.output_index, delta: event.delta }),
        ]
      case "response.function_call_arguments.delta":
        return [
          ProviderEvent.ToolCallInputDelta({
            contentIndex: event.output_index,
            partialJson: event.delta,
          }),
        ]
      case "response.output_item.done": {
        const blob = event.item?.type === "reasoning" ? event.item : undefined
        return [
          ProviderEvent.BlockEnd({
            contentIndex: event.output_index,
            ...(blob !== undefined ? { providerBlob: blob } : {}),
          }),
        ]
      }
      case "response.completed": {
        const usage = event.response?.usage
        const normalized: Usage = {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
        }
        const stopReason: StopReason = sawToolCall ? "toolUse" : "endTurn"
        return [ProviderEvent.Done({ stopReason, usage: normalized })]
      }
      case "response.failed":
      case "error":
        return new ProviderError({
          message: `provider error: ${JSON.stringify(event.response?.error ?? event)}`,
        })
      default:
        return []
    }
  }
}
