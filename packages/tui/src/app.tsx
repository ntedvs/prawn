import { createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import { createTranscript, type Entry, type TranscriptState } from "./transcript.js"
import type { Session } from "./session.js"
import type { Message } from "@prawn/core"

const COLORS = {
  user: "#7dd3fc",
  thinking: "#6b7280",
  tool: "#fbbf24",
  ok: "#86efac",
  err: "#f87171",
  dim: "#9ca3af",
}

const EntryView = (props: { entry: Entry }) => {
  const entry = props.entry
  switch (entry.kind) {
    case "user":
      return <text content={`› ${entry.text}`} fg={COLORS.user} />
    case "assistant":
      return <text content={entry.text} />
    case "thinking":
      return <text content={entry.text} fg={COLORS.thinking} />
    case "tool":
      return (
        <box border borderColor="#374151" title={(entry as Extract<Entry, { kind: "tool" }>).name}>
          <text
            content={`$ ${(entry as Extract<Entry, { kind: "tool" }>).args}`}
            fg={COLORS.tool}
          />
          <Show when={(entry as Extract<Entry, { kind: "tool" }>).running}>
            <text content="running…" fg={COLORS.dim} />
          </Show>
          <Show when={(entry as Extract<Entry, { kind: "tool" }>).output !== undefined}>
            <text
              content={
                ((entry as Extract<Entry, { kind: "tool" }>).isError ? "✗ " : "✓ ") +
                (entry as Extract<Entry, { kind: "tool" }>).output
              }
              fg={(entry as Extract<Entry, { kind: "tool" }>).isError ? COLORS.err : COLORS.ok}
            />
          </Show>
        </box>
      )
  }
}

export const App = (props: {
  session: Session
  provider: string
  initial?: ReadonlyArray<Message>
}) => {
  const [store, setStore] = createStore<TranscriptState>({ entries: [], status: "idle" })
  const transcript = createTranscript(setStore)
  const [draft, setDraft] = createSignal("")

  onMount(() => {
    if (props.initial && props.initial.length > 0) transcript.seed(props.initial)
    props.session.onEvent((event) => transcript.apply(event))
  })
  useKeyboard((key) => {
    if (key.name === "escape") props.session.interrupt()
  })

  const submit = (value: string) => {
    const trimmed = value.trim()
    if (trimmed === "") return
    transcript.pushUser(trimmed)
    props.session.submit(trimmed)
    setDraft("")
  }

  return (
    <box height="100%" flexDirection="column">
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ flexGrow: 1, gap: 0 }}
      >
        <For each={store.entries}>{(entry) => <EntryView entry={entry} />}</For>
      </scrollbox>

      <box flexDirection="column" flexShrink={0}>
        <text
          content={`prawn · ${props.provider} · ${store.status}  (esc to interrupt, ^C to quit)`}
          fg={COLORS.dim}
        />
        <box height={3} border borderColor="#374151">
          <input
            focused
            placeholder="ask prawn to do something…"
            value={draft()}
            onInput={setDraft}
            onSubmit={submit as never}
          />
        </box>
      </box>
    </box>
  )
}
