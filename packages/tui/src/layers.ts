import { Layer } from "effect"
import {
  eventBusLive,
  sessionStorePersistent,
  steeringLive,
  toolRegistryLayer,
  type SessionHandle,
} from "@prawn/core"
import { codexProviderLayer, hasOpenAIAuth, mockProviderLayer } from "@prawn/providers"
import { bashTool } from "@prawn/tools"

export const usingMock = !hasOpenAIAuth()

export const liveLayer = (handle: SessionHandle) =>
  Layer.mergeAll(
    eventBusLive,
    sessionStorePersistent(handle),
    steeringLive,
    toolRegistryLayer([bashTool]),
    usingMock ? mockProviderLayer : codexProviderLayer(),
  )

export type LiveLayer = ReturnType<typeof liveLayer>
