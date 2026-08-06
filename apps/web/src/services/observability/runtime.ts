import config from '@payload-config'
import { getPayload } from 'payload'

import { createProviderObservabilityLogger } from '@/services/observability/provider-metrics-logger'
import {
  PayloadToolObservabilityStore,
  type ToolObservabilityStore,
} from '@/services/observability/tool-observability'

const disabledTestStore: ToolObservabilityStore = { record: async () => undefined }

export const runtimeToolObservabilityStore: ToolObservabilityStore =
  process.env.NODE_ENV === 'test'
    ? disabledTestStore
    : new PayloadToolObservabilityStore(() => getPayload({ config }))

export const runtimeProviderObservability = createProviderObservabilityLogger(
  runtimeToolObservabilityStore,
)
