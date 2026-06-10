import { createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { SessionMeta } from "@prawn/core"

const COLORS = {
  sel: "#7dd3fc",
  dim: "#9ca3af",
  meta: "#6b7280",
  title: "#e5e7eb",
}

const when = (ms: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Resume picker: arrow keys + enter to choose, n for a new session, esc/q to
// quit. onChoose(null) means "start fresh". Global scope also shows cwd.
export const Picker = (props: {
  metas: ReadonlyArray<SessionMeta>
  global: boolean
  onChoose: (id: string | null) => void
  onQuit: () => void
}) => {
  const [cursor, setCursor] = createSignal(0)
  const max = () => props.metas.length - 1

  useKeyboard((key) => {
    if (key.name === "up" || key.name === "k") setCursor((c) => Math.max(0, c - 1))
    else if (key.name === "down" || key.name === "j") setCursor((c) => Math.min(max(), c + 1))
    else if (key.name === "n") props.onChoose(null)
    else if (key.name === "return") {
      const meta = props.metas[cursor()]
      props.onChoose(meta ? meta.id : null)
    } else if (key.name === "escape" || key.name === "q") props.onQuit()
  })

  return (
    <box height="100%" flexDirection="column" padding={1}>
      <text
        content={`prawn · resume a session${props.global ? " (global)" : ""}`}
        fg={COLORS.title}
      />
      <text content="↑/↓ select · enter resume · n new · esc quit" fg={COLORS.dim} />
      <box height={1} />
      <Show
        when={props.metas.length > 0}
        fallback={
          <text content="no saved sessions — press n (or enter) for a new one" fg={COLORS.dim} />
        }
      >
        <box flexDirection="column">
          <For each={props.metas}>
            {(meta, i) => {
              const active = () => i() === cursor()
              return (
                <text
                  content={`${active() ? "❯ " : "  "}${meta.title}   ${when(meta.updatedAt)}${
                    props.global ? `   ${meta.cwd}` : ""
                  }`}
                  fg={active() ? COLORS.sel : COLORS.meta}
                />
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}
