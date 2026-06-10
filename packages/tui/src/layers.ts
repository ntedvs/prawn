import { Layer } from "effect"
import { eventBusLive, sessionStorePersistent, steeringLive, type SessionHandle } from "@prawn/core"
import { mcpToolRegistryLayer } from "@prawn/mcp"
import { codexProviderLayer, hasOpenAIAuth, mockProviderLayer } from "@prawn/providers"
import { bashTool } from "@prawn/tools"

export const usingMock = !hasOpenAIAuth()

export const liveLayer = (handle: SessionHandle, cwd = process.cwd()) =>
  Layer.mergeAll(
    eventBusLive,
    sessionStorePersistent(handle),
    steeringLive,
    mcpToolRegistryLayer([bashTool], { cwd }),
    usingMock ? mockProviderLayer : codexProviderLayer({ cwd }),
  )

export type LiveLayer = ReturnType<typeof liveLayer>
