import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer, Ref, Schema } from "effect"
import { Message, textOf } from "./message.js"
import { SessionStore } from "./services.js"

// On-disk session: the full message history plus enough metadata to list and
// resume it. `messages` reuses the core Message schema, so reasoning providerBlobs
// (needed for verbatim replay) round-trip for free.
export const SessionFile = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  title: Schema.String,
  messages: Schema.Array(Message),
})
export type SessionFile = typeof SessionFile.Type

export type SessionMeta = Omit<SessionFile, "messages">

const SESSIONS_DIR = path.join(os.homedir(), ".prawn", "sessions")
const fileOf = (id: string) => path.join(SESSIONS_DIR, `${id}.json`)

const newSessionId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// First user line, collapsed and clipped — the picker label.
const titleFrom = (messages: ReadonlyArray<Message>): string => {
  const first = messages.find((m) => m._tag === "UserMessage")
  const text = first ? textOf(first.blocks).replace(/\s+/g, " ").trim() : ""
  return text.slice(0, 72) || "(empty)"
}

const decodeFile = Schema.decodeUnknownSync(SessionFile)

// A live session: identity + seed history handed to the persistent store layer.
export interface SessionHandle {
  readonly id: string
  readonly cwd: string
  readonly createdAt: number
  readonly initial: ReadonlyArray<Message>
}

export const newSession = (cwd: string): SessionHandle => ({
  id: newSessionId(),
  cwd,
  createdAt: Date.now(),
  initial: [],
})

export const handleFromFile = (file: SessionFile): SessionHandle => ({
  id: file.id,
  cwd: file.cwd,
  createdAt: file.createdAt,
  initial: file.messages,
})

export const loadSession = async (id: string): Promise<SessionFile> =>
  decodeFile(JSON.parse(await fs.readFile(fileOf(id), "utf8")))

// Lists session metadata (newest first). `cwd` filters to one project; omit for
// the global pool. Unreadable/corrupt files are skipped, not fatal.
export const listSessions = async (opts?: {
  readonly cwd?: string
}): Promise<ReadonlyArray<SessionMeta>> => {
  let names: ReadonlyArray<string>
  try {
    names = await fs.readdir(SESSIONS_DIR)
  } catch {
    return []
  }
  const metas = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n): Promise<SessionMeta | null> => {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, n), "utf8"))
          return {
            id: String(raw.id),
            cwd: String(raw.cwd),
            createdAt: Number(raw.createdAt),
            updatedAt: Number(raw.updatedAt),
            title: String(raw.title),
          }
        } catch {
          return null
        }
      }),
  )
  return metas
    .filter((m): m is SessionMeta => m !== null)
    .filter((m) => opts?.cwd === undefined || m.cwd === opts.cwd)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export const latestSession = async (cwd: string): Promise<SessionMeta | undefined> =>
  (await listSessions({ cwd }))[0]

// SessionStore backed by a file: seeds from the handle and rewrites the whole
// file on every append. Append is sequential within the loop, so writes never
// race; "after every turn" is a floor, and this is crash-safe to the message.
export const sessionStorePersistent = (handle: SessionHandle) =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Message>>(handle.initial)
      const persist = Ref.get(ref).pipe(
        Effect.flatMap((messages) =>
          Effect.promise(async () => {
            await fs.mkdir(SESSIONS_DIR, { recursive: true })
            const file: SessionFile = {
              id: handle.id,
              cwd: handle.cwd,
              createdAt: handle.createdAt,
              updatedAt: Date.now(),
              title: titleFrom(messages),
              messages,
            }
            await fs.writeFile(fileOf(handle.id), JSON.stringify(file))
          }),
        ),
      )
      return {
        append: (message) =>
          Ref.update(ref, (messages) => [...messages, message]).pipe(Effect.zipRight(persist)),
        history: Ref.get(ref),
      }
    }),
  )
