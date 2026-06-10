import { render } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import {
  handleFromFile,
  latestSession,
  listSessions,
  loadSession,
  newSession,
  type SessionHandle,
  type SessionMeta,
} from "@prawn/core"
import { App } from "./app.js"
import { Picker } from "./picker.js"
import { createSession, type Session } from "./session.js"
import { liveLayer, usingMock } from "./layers.js"

const argv = process.argv.slice(2)
const has = (...flags: ReadonlyArray<string>) => flags.some((f) => argv.includes(f))
const valueOf = (...flags: ReadonlyArray<string>): string | undefined => {
  for (const flag of flags) {
    const i = argv.indexOf(flag)
    if (i >= 0) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("-")) return next
    }
  }
  return undefined
}

const cwd = process.cwd()
const global = has("--global", "-g")
const providerLabel = usingMock ? "mock (run `bun run dev login`)" : "openai-codex"

// Resolve the non-interactive startup modes up front. Picker mode defers the
// choice to the UI, so it only pre-loads the candidate list.
let initialHandle: SessionHandle | null = null
let pickMetas: ReadonlyArray<SessionMeta> = []

if (has("--continue", "-c")) {
  const latest = await latestSession(cwd)
  initialHandle = latest ? handleFromFile(await loadSession(latest.id)) : newSession(cwd)
} else if (has("--resume", "-r")) {
  const id = valueOf("--resume", "-r")
  if (id !== undefined) {
    initialHandle = handleFromFile(await loadSession(id))
  } else {
    pickMetas = await listSessions(global ? {} : { cwd })
  }
} else {
  initialHandle = newSession(cwd)
}

const Root = () => {
  const [handle, setHandle] = createSignal<SessionHandle | null>(initialHandle)

  const choose = (id: string | null) => {
    if (id === null) setHandle(newSession(cwd))
    else loadSession(id).then((file) => setHandle(handleFromFile(file)))
  }

  // Build the session exactly once, when a handle exists.
  const ready = createMemo(() => {
    const h = handle()
    return h ? { session: createSession(liveLayer(h, cwd)), handle: h } : null
  })

  return (
    <Show
      when={ready()}
      fallback={
        <Picker
          metas={pickMetas}
          global={global}
          onChoose={choose}
          onQuit={() => process.exit(0)}
        />
      }
    >
      {(r: () => { session: Session; handle: SessionHandle }) => (
        <App session={r().session} provider={providerLabel} initial={r().handle.initial} />
      )}
    </Show>
  )
}

render(() => <Root />, {
  targetFps: 30,
  exitOnCtrlC: true,
})
