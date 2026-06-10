import { Context, Data, Effect, Layer, type Schema } from "effect"

export class ToolFailure extends Data.TaggedError("ToolFailure")<{
  readonly message: string
}> {}

export class UnknownToolError extends Data.TaggedError("UnknownToolError")<{
  readonly name: string
}> {}

// `readonly` drives dispatch: readonly tools run concurrently, mutating ones
// sequentially. Inputs are Schema-validated before execute runs, regardless
// of provider strict-mode claims.
export interface AgentTool<I = unknown> {
  readonly name: string
  readonly description: string
  readonly params: Schema.Schema<I, any, never>
  readonly readonly: boolean
  readonly execute: (input: I) => Effect.Effect<string, ToolFailure>
}
export type AnyAgentTool = AgentTool<any>

export const defineTool = <I>(tool: AgentTool<I>): AgentTool<I> => tool

export interface ToolRegistryShape {
  readonly all: ReadonlyArray<AnyAgentTool>
  readonly lookup: (name: string) => Effect.Effect<AnyAgentTool, UnknownToolError>
}

export class ToolRegistry extends Context.Tag("prawn/ToolRegistry")<
  ToolRegistry,
  ToolRegistryShape
>() {}

export const toolRegistryLayer = (tools: ReadonlyArray<AnyAgentTool>) =>
  Layer.succeed(ToolRegistry, {
    all: tools,
    lookup: (name) => {
      const tool = tools.find((t) => t.name === name)
      return tool ? Effect.succeed(tool) : Effect.fail(new UnknownToolError({ name }))
    },
  })
