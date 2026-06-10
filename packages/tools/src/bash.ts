import { Effect, Schema } from "effect"
import { ToolFailure, defineTool } from "@prawn/core"

const BashParams = Schema.Struct({
  command: Schema.String,
})

export const bashTool = defineTool({
  name: "bash",
  description: "Run a shell command and return its combined stdout/stderr.",
  params: BashParams,
  readonly: false,
  execute: ({ command }) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { stdout, stderr, exitCode }
      },
      catch: (error) => new ToolFailure({ message: `spawn failed: ${String(error)}` }),
    }).pipe(
      Effect.flatMap(({ stdout, stderr, exitCode }) =>
        exitCode === 0
          ? Effect.succeed(stdout + stderr)
          : Effect.fail(
              new ToolFailure({ message: `exit ${exitCode}: ${(stderr || stdout).trim()}` }),
            ),
      ),
    ),
})
