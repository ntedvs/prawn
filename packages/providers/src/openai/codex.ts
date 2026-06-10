import { Layer } from "effect"
import { ProviderClient } from "@prawn/core"
import { codexHeaders } from "./auth.js"
import { makeResponsesClient } from "./responses.js"

export interface CodexOptions {
  readonly modelId?: string
  readonly instructions?: string
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"
}

// Subscription-billed Responses API via the ChatGPT Codex backend.
// Constraints (verified against pi-ai and codex-rs): store must be false,
// stream must be true, reasoning.encrypted_content must be included and
// replayed verbatim across turns — all handled by makeResponsesClient.
export const codexProviderLayer = (options: CodexOptions = {}) =>
  Layer.succeed(
    ProviderClient,
    makeResponsesClient({
      providerId: "openai-codex",
      modelId: options.modelId ?? "gpt-5.5",
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: codexHeaders,
      instructions:
        options.instructions ??
        "You are prawn, a coding agent running in a terminal. Use the available tools to accomplish the user's task, then summarize what you did.",
      reasoning: { effort: options.reasoningEffort ?? "medium", summary: "auto" },
      extraBody: {
        tool_choice: "auto",
        text: { verbosity: "low" },
      },
    }),
  )
