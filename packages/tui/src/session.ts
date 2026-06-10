import { Effect, Fiber, ManagedRuntime, Queue, Ref, Stream } from "effect"
import { EventBus, runAgent, userText, type AgentEvent, type UserMessage } from "@prawn/core"
import type { LiveLayer } from "./layers.js"

// Bridges the Effect agent core to the (non-Effect) Solid TUI. Owns a
// ManagedRuntime, an input queue, and the handle of the in-flight turn so it
// can be interrupted. The UI calls submit/interrupt/onEvent as plain methods.
export interface Session {
  readonly submit: (text: string) => void
  readonly interrupt: () => void
  readonly onEvent: (handler: (event: AgentEvent) => void) => void
  readonly shutdown: () => Promise<void>
}

export const createSession = (layer: LiveLayer): Session => {
  const runtime = ManagedRuntime.make(layer)
  const inputQueue = Effect.runSync(Queue.unbounded<UserMessage>())
  const current = Effect.runSync(Ref.make<Fiber.RuntimeFiber<void, unknown> | null>(null))

  // One turn-set at a time: take a prompt, run the loop to completion, repeat.
  // Each run is forked so interrupt() can tear down its provider stream via Scope.
  const driver = Effect.gen(function* () {
    while (true) {
      const message = yield* Queue.take(inputQueue)
      const fiber = yield* Effect.fork(runAgent(message))
      yield* Ref.set(current, fiber)
      yield* Fiber.join(fiber).pipe(Effect.catchAllCause(() => Effect.void))
      yield* Ref.set(current, null)
    }
  })
  runtime.runFork(driver)

  return {
    submit: (text) => {
      Effect.runSync(Queue.offer(inputQueue, userText(text)))
    },
    interrupt: () => {
      runtime.runFork(
        Ref.get(current).pipe(
          Effect.flatMap((fiber) => (fiber ? Fiber.interrupt(fiber) : Effect.void)),
        ),
      )
    },
    onEvent: (handler) => {
      runtime.runFork(
        Effect.gen(function* () {
          const bus = yield* EventBus
          const stream = yield* bus.subscribe
          yield* Stream.runForEach(stream, (event) => Effect.sync(() => handler(event)))
        }).pipe(Effect.scoped),
      )
    },
    shutdown: () => runtime.dispose(),
  }
}
