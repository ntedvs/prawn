import { homedir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { Effect, Layer, Schema } from "effect"
import {
  ToolFailure,
  ToolRegistry,
  UnknownToolError,
  defineTool,
  type AnyAgentTool,
} from "@prawn/core"

type JsonObject = Record<string, unknown>

interface BaseServerConfig {
  readonly enabled?: boolean
  readonly env?: Record<string, string>
  readonly headers?: Record<string, string>
  readonly cwd?: string
}

interface StdioServerConfig extends BaseServerConfig {
  readonly transport?: "stdio"
  readonly command: string
  readonly args?: ReadonlyArray<string>
}

interface HttpServerConfig extends BaseServerConfig {
  readonly transport?: "http" | "streamable-http"
  readonly type?: "http" | "streamable-http"
  readonly url: string
}

type ServerConfig = StdioServerConfig | HttpServerConfig

interface McpConfig {
  readonly servers?: Record<string, ServerConfig>
  readonly mcpServers?: Record<string, ServerConfig>
}

export interface LoadMcpToolsOptions {
  readonly cwd?: string
  readonly configPaths?: ReadonlyArray<string>
}

interface LoadedServer {
  readonly client: Client
  readonly tools: ReadonlyArray<AnyAgentTool>
}

interface McpToolset {
  readonly tools: ReadonlyArray<AnyAgentTool>
  readonly close: () => Promise<void>
}

export const defaultMcpConfigPaths = (cwd = process.cwd()): ReadonlyArray<string> => [
  join(homedir(), ".prawn", "mcp.json"),
  join(cwd, ".prawn", "mcp.json"),
]

export const loadMcpTools = async (
  options: LoadMcpToolsOptions = {},
): Promise<ReadonlyArray<AnyAgentTool>> => {
  const toolset = await loadMcpToolset(options)
  return toolset.tools
}

const loadMcpToolset = async (options: LoadMcpToolsOptions = {}): Promise<McpToolset> => {
  const cwd = options.cwd ?? process.cwd()
  const config = await loadConfig(options.configPaths ?? defaultMcpConfigPaths(cwd))
  const servers = Object.entries(config.servers ?? {}).filter(
    ([, server]) => server.enabled !== false,
  )
  const nested = await Promise.all(
    servers.map(async ([name, server]) => loadServerTools(name, server, cwd)),
  )
  return {
    tools: nested.flatMap((server) => server.tools),
    close: async () => {
      await Promise.allSettled(nested.map((server) => server.client.close()))
    },
  }
}

export const mcpToolRegistryLayer = (
  baseTools: ReadonlyArray<AnyAgentTool>,
  options: LoadMcpToolsOptions = {},
) =>
  Layer.scoped(
    ToolRegistry,
    Effect.acquireRelease(
      Effect.promise(() => loadMcpToolset(options)).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => console.warn(`MCP disabled: ${String(error)}`)),
        ),
        Effect.catchAll(() => Effect.succeed({ tools: [], close: async () => {} })),
      ),
      (toolset) => Effect.promise(() => toolset.close()).pipe(Effect.orDie),
    ).pipe(
      Effect.map((toolset) => {
        const tools = [...baseTools, ...toolset.tools]
        return {
          all: tools,
          lookup: (name: string) => {
            const tool = tools.find((candidate) => candidate.name === name)
            return tool ? Effect.succeed(tool) : Effect.fail(new UnknownToolError({ name }))
          },
        }
      }),
    ),
  )

const loadConfig = async (paths: ReadonlyArray<string>): Promise<McpConfig> => {
  let merged: McpConfig = {}
  for (const path of paths) {
    const file = Bun.file(path)
    if (!(await file.exists())) continue
    const parsed = (await file.json()) as McpConfig
    merged = {
      ...merged,
      ...parsed,
      servers: {
        ...(merged.servers ?? {}),
        ...(parsed.mcpServers ?? {}),
        ...(parsed.servers ?? {}),
      },
      mcpServers: {
        ...(merged.mcpServers ?? {}),
        ...(parsed.mcpServers ?? {}),
      },
    }
  }
  return merged
}

const loadServerTools = async (
  serverName: string,
  config: ServerConfig,
  cwd: string,
): Promise<LoadedServer> => {
  const client = new Client({ name: "prawn", version: "0.0.1" }, { capabilities: {} })
  await client.connect(makeTransport(config, cwd))
  const listed = await client.listTools()
  return {
    client,
    tools: listed.tools.map((tool) =>
      defineTool({
        name: toolName(serverName, tool.name),
        description: describeTool(serverName, tool.description),
        params: Schema.Unknown,
        jsonSchema: tool.inputSchema,
        readonly: tool.annotations?.readOnlyHint === true,
        execute: (input) =>
          Effect.tryPromise({
            try: async () => {
              const result = await client.callTool({
                name: tool.name,
                arguments: input as JsonObject,
              })
              if ("toolResult" in result) return stringify(result.toolResult)
              const text = [
                ...(result.content ?? []).map(renderContent),
                result.structuredContent === undefined ? "" : stringify(result.structuredContent),
              ]
                .filter((part) => part !== "")
                .join("\n")
              if (result.isError === true) throw new Error(text || "MCP tool returned an error")
              return text
            },
            catch: (error) =>
              new ToolFailure({
                message: error instanceof Error ? error.message : String(error),
              }),
          }),
      }),
    ),
  }
}

const makeTransport = (config: ServerConfig, cwd: string): Transport => {
  if ("url" in config) {
    return new StreamableHTTPClientTransport(new URL(expand(config.url)), {
      requestInit: { headers: expandRecord(config.headers ?? {}) },
    }) as Transport
  }

  const params = {
    command: expand(config.command),
    env: { ...process.env, ...expandRecord(config.env ?? {}) } as Record<string, string>,
    cwd: config.cwd === undefined ? cwd : expand(config.cwd),
    ...(config.args === undefined ? {} : { args: config.args.map(expand) }),
  }
  return new StdioClientTransport(params) as Transport
}

const describeTool = (serverName: string, description: string | undefined) =>
  `[MCP:${serverName}] ${description ?? "Tool provided by an MCP server."}`

const toolName = (serverName: string, name: string) =>
  `mcp_${sanitize(serverName)}_${sanitize(name)}`.slice(0, 64)

const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

const expandRecord = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]))

const expand = (value: string): string =>
  value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? "")

const stringify = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2)

const renderContent = (content: unknown): string => {
  if (typeof content !== "object" || content === null) return stringify(content)
  const block = content as JsonObject
  if (block.type === "text" && typeof block.text === "string") return block.text
  if (block.type === "resource" && typeof block.resource === "object" && block.resource !== null) {
    const resource = block.resource as JsonObject
    if (typeof resource.text === "string") return resource.text
    return stringify(resource)
  }
  if (block.type === "image") return `[image: ${String(block.mimeType ?? "unknown")}]`
  if (block.type === "audio") return `[audio: ${String(block.mimeType ?? "unknown")}]`
  if (block.type === "resource_link") return stringify(block)
  return stringify(block)
}
