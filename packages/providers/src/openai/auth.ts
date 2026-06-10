import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ProviderError } from "@prawn/core"

// "Sign in with ChatGPT" — the same OAuth client Codex CLI uses, so requests
// bill against the user's ChatGPT subscription instead of an API key.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const REDIRECT_URI = "http://localhost:1455/auth/callback"
const SCOPE = "openid profile email offline_access"
const JWT_CLAIM = "https://api.openai.com/auth"

const AUTH_FILE = path.join(os.homedir(), ".prawn", "auth.json")

interface OpenAICredentials {
  access: string
  refresh: string
  expires: number
  accountId: string
}

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const decodeJwtPayload = (token: string): Record<string, any> => {
  const payload = token.split(".")[1]
  if (!payload) throw new Error("malformed JWT in token response")
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
}

const extractAccountId = (accessToken: string): string => {
  const accountId = decodeJwtPayload(accessToken)[JWT_CLAIM]?.chatgpt_account_id
  if (typeof accountId !== "string") {
    throw new Error("no chatgpt_account_id in access token — is this a ChatGPT account?")
  }
  return accountId
}

const tokenRequest = async (params: Record<string, string>): Promise<OpenAICredentials> => {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  })
  if (!response.ok) {
    throw new Error(`token request failed: HTTP ${response.status} ${await response.text()}`)
  }
  const json = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  }
}

const readAuth = async (): Promise<OpenAICredentials | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(AUTH_FILE, "utf8"))
    return parsed.openai
  } catch {
    return undefined
  }
}

const writeAuth = async (credentials: OpenAICredentials): Promise<void> => {
  await mkdir(path.dirname(AUTH_FILE), { recursive: true })
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(AUTH_FILE, "utf8"))
  } catch {
    // first login
  }
  await writeFile(AUTH_FILE, JSON.stringify({ ...existing, openai: credentials }, null, 2))
}

export const hasOpenAIAuth = (): boolean => existsSync(AUTH_FILE)

export const loginOpenAI = async (): Promise<void> => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))

  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "prawn",
  }).toString()

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port: 1455,
      fetch(request) {
        const requestUrl = new URL(request.url)
        if (requestUrl.pathname !== "/auth/callback") {
          return new Response("not found", { status: 404 })
        }
        const finish = (body: string, status: number, outcome?: () => void) => {
          outcome?.()
          setTimeout(() => server.stop(true), 100)
          return new Response(body, { status, headers: { "content-type": "text/plain" } })
        }
        const error = requestUrl.searchParams.get("error")
        if (error) {
          return finish(`Login failed: ${error}`, 400, () => reject(new Error(error)))
        }
        if (requestUrl.searchParams.get("state") !== state) {
          return finish("State mismatch.", 400, () => reject(new Error("state mismatch")))
        }
        const authCode = requestUrl.searchParams.get("code")
        if (!authCode) {
          return finish("Missing code.", 400, () => reject(new Error("missing code")))
        }
        return finish("Login successful — return to your terminal.", 200, () => resolve(authCode))
      },
    })
    console.log(`Opening browser for ChatGPT login...\nIf it doesn't open, visit:\n${url}`)
    Bun.spawn(["open", url.toString()], { stdout: "ignore", stderr: "ignore" })
  })

  const credentials = await tokenRequest({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  })
  await writeAuth(credentials)
  console.log(`Logged in (account ${credentials.accountId}). Tokens saved to ${AUTH_FILE}`)
}

const sessionId = crypto.randomUUID()

// Loads credentials, refreshing up to 60s before expiry. Effectful so every
// request re-checks; refresh results are persisted for other processes.
export const codexHeaders: Effect.Effect<Record<string, string>, ProviderError> = Effect.tryPromise(
  {
    try: async () => {
      let credentials = await readAuth()
      if (!credentials) {
        throw new Error("not logged in — run: bun run dev login")
      }
      if (Date.now() >= credentials.expires - 60_000) {
        credentials = await tokenRequest({
          grant_type: "refresh_token",
          refresh_token: credentials.refresh,
          client_id: CLIENT_ID,
        })
        await writeAuth(credentials)
      }
      return {
        authorization: `Bearer ${credentials.access}`,
        "chatgpt-account-id": credentials.accountId,
        originator: "prawn",
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "session-id": sessionId,
        "x-client-request-id": sessionId,
        "User-Agent": `prawn (${process.platform} ${os.release()}; ${process.arch})`,
      }
    },
    catch: (cause) => new ProviderError({ message: String(cause), cause }),
  },
)
