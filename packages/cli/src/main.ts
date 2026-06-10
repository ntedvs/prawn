import { Effect, Fiber, Layer, Stream } from "effect"
import {
  EventBus,
  eventBusLive,
  handleFromFile,
  latestSession,
  loadSession,
  newSession,
  runAgent,
  sessionStorePersistent,
  steeringLive,
  userText,
  type AgentEvent,
  type SessionHandle,
} from "@prawn/core"
import { mcpToolRegistryLayer } from "@prawn/mcp"
import { codexProviderLayer, hasOpenAIAuth, loginOpenAI, mockProviderLayer } from "@prawn/providers"
import { bashTool } from "@prawn/tools"

const write = (text: string) => Effect.sync(() => void process.stdout.write(text))

const render = (event: AgentEvent) => {
  switch (event._tag) {
    case "TurnStart":
      return write("\n── turn ──\n")
    case "TextDelta":
      return write(event.delta)
    case "ThinkingDelta":
      return write(`\x1b[2m${event.delta}\x1b[0m`)
    case "ToolCallStart":
      return write(`\n→ ${event.name} `)
    case "ToolCallDelta":
      return write(`\r→ tool call: ${JSON.stringify(event.partialInput)}`)
    case "ToolCallEnd":
      return write(`\r→ ${event.name}(${JSON.stringify(event.input)})\n`)
    case "ToolExecutionStart":
      return write(`  running ${event.name}...\n`)
    case "ToolExecutionEnd":
      return write(`  ${event.isError ? "✗" : "✓"} ${event.name}: ${event.output.trim()}\n`)
    case "AssistantDone":
      return write(
        `\n  [stop: ${event.stopReason}, tokens: ${event.usage.inputTokens}in/${event.usage.outputTokens}out]\n`,
      )
    case "AgentEnd":
      return write("\n── done ──\n")
    default:
      return Effect.void
  }
}

const program = (prompt: string) =>
  Effect.gen(function* () {
    const bus = yield* EventBus
    const events = yield* bus.subscribe
    const printer = yield* Effect.fork(
      events.pipe(
        Stream.takeUntil((event) => event._tag === "AgentEnd"),
        Stream.runForEach(render),
      ),
    )
    yield* runAgent(userText(prompt))
    yield* Fiber.join(printer)
  }).pipe(Effect.scoped)

const args = process.argv.slice(2)

if (args[0] === "login") {
  await loginOpenAI()
  process.exit(0)
}

const cwd = process.cwd()
const take = (...flags: ReadonlyArray<string>) => flags.some((f) => args.includes(f))
const valueOf = (...flags: ReadonlyArray<string>): string | undefined => {
  for (const flag of flags) {
    const i = args.indexOf(flag)
    if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1]
  }
  return undefined
}

let handle: SessionHandle
if (take("--continue", "-c")) {
  const latest = await latestSession(cwd)
  handle = latest ? handleFromFile(await loadSession(latest.id)) : newSession(cwd)
} else {
  const id = valueOf("--resume", "-r")
  handle = id !== undefined ? handleFromFile(await loadSession(id)) : newSession(cwd)
}

const FLAGS = new Set(["--mock", "--continue", "-c", "--resume", "-r", valueOf("--resume", "-r")])
const useMock = args.includes("--mock") || !hasOpenAIAuth()
const prompt =
  args.filter((a) => !FLAGS.has(a)).join(" ") ||
  "Run `echo hello from prawn` and tell me what it printed."

if (useMock && !args.includes("--mock")) {
  console.log("(no OpenAI login found — using mock provider; run `bun run dev login` first)")
}

const live = Layer.mergeAll(
  eventBusLive,
  sessionStorePersistent(handle),
  steeringLive,
  mcpToolRegistryLayer([bashTool], { cwd }),
  useMock ? mockProviderLayer : codexProviderLayer({ cwd }),
)

Effect.runPromise(program(prompt).pipe(Effect.provide(live))).catch((error) => {
  console.error(error)
  process.exit(1)
})
