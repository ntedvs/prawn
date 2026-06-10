import { Context, Effect, Layer, PubSub, Queue, Ref, Scope, Stream } from "effect"
import type { AgentEvent } from "./events.js"
import type { Message, UserMessage } from "./message.js"

export interface EventBusShape {
  readonly publish: (event: AgentEvent) => Effect.Effect<void>
  readonly subscribe: Effect.Effect<Stream.Stream<AgentEvent>, never, Scope.Scope>
}

export class EventBus extends Context.Tag("prawn/EventBus")<EventBus, EventBusShape>() {}

export const eventBusLive = Layer.effect(
  EventBus,
  Effect.map(PubSub.unbounded<AgentEvent>(), (pubsub) => ({
    publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
    subscribe: Effect.map(PubSub.subscribe(pubsub), Stream.fromQueue),
  })),
)

export interface SessionStoreShape {
  readonly append: (message: Message) => Effect.Effect<void>
  readonly history: Effect.Effect<ReadonlyArray<Message>>
}

export class SessionStore extends Context.Tag("prawn/SessionStore")<
  SessionStore,
  SessionStoreShape
>() {}

export const sessionStoreInMemory = Layer.effect(
  SessionStore,
  Effect.map(Ref.make<ReadonlyArray<Message>>([]), (ref) => ({
    append: (message) => Ref.update(ref, (messages) => [...messages, message]),
    history: Ref.get(ref),
  })),
)

// Mid-turn user input: drained into history at the top of every loop iteration.
export interface SteeringShape {
  readonly offer: (message: UserMessage) => Effect.Effect<void>
  readonly drain: Effect.Effect<ReadonlyArray<UserMessage>>
}

export class Steering extends Context.Tag("prawn/Steering")<Steering, SteeringShape>() {}

export const steeringLive = Layer.effect(
  Steering,
  Effect.map(Queue.unbounded<UserMessage>(), (queue) => ({
    offer: (message) => Queue.offer(queue, message).pipe(Effect.asVoid),
    drain: Queue.takeAll(queue).pipe(Effect.map((chunk) => [...chunk])),
  })),
)
