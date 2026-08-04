import type { DomainProvider } from './types'
import { mockSuccess } from './mock'

export class MockWestDigitalProvider implements DomainProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async queryRegistration() {
    return mockSuccess({ registered: false })
  }

  async submitOperation(input: { operationKey: string; traceId: string }) {
    return mockSuccess({ providerRequestId: `mock-${input.operationKey}` })
  }
}
