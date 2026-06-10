import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { ProviderClient } from "@prawn/core"
import { codexHeaders } from "./auth.js"
import { makeResponsesClient } from "./responses.js"

export interface CodexOptions {
  readonly modelId?: string
  readonly instructions?: string
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"
  readonly cwd?: string
}

const DEFAULT_INSTRUCTIONS =
  "You are prawn, a coding agent running in a terminal. Use the available tools to accomplish the user's task, then summarize what you did."

const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    const text = await readFile(path, "utf8")
    const trimmed = text.trim()
    return trimmed === "" ? undefined : trimmed
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

export const defaultAgentInstructionPaths = (cwd = process.cwd()): ReadonlyArray<string> => [
  join(homedir(), ".prawn", "AGENTS.md"),
  join(cwd, "AGENTS.md"),
]

export const loadAgentInstructions = async (cwd = process.cwd()): Promise<string> => {
  const sections = await Promise.all(
    defaultAgentInstructionPaths(cwd).map(async (path) => ({
      path,
      text: await readOptional(path),
    })),
  )
  return sections
    .filter(
      (section): section is { readonly path: string; readonly text: string } =>
        section.text !== undefined,
    )
    .map((section) => `Instructions from ${section.path}:\n\n${section.text}`)
    .join("\n\n")
}

const instructionsWithAgents = async (options: CodexOptions): Promise<string> => {
  const base = options.instructions ?? DEFAULT_INSTRUCTIONS
  const agents = await loadAgentInstructions(options.cwd)
  return agents === "" ? base : `${base}\n\n${agents}`
}

// Subscription-billed Responses API via the ChatGPT Codex backend.
// Constraints (verified against pi-ai and codex-rs): store must be false,
// stream must be true, reasoning.encrypted_content must be included and
// replayed verbatim across turns — all handled by makeResponsesClient.
export const codexProviderLayer = (options: CodexOptions = {}) =>
  Layer.effect(
    ProviderClient,
    Effect.promise(async () =>
      makeResponsesClient({
        providerId: "openai-codex",
        modelId: options.modelId ?? "gpt-5.5",
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers: codexHeaders,
        instructions: await instructionsWithAgents(options),
        reasoning: { effort: options.reasoningEffort ?? "medium", summary: "auto" },
        extraBody: {
          tool_choice: "auto",
          text: { verbosity: "low" },
        },
      }),
    ),
  )
