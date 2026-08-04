import type { PaymentProvider } from './types'
import { mockSuccess } from './mock'

export class MockWechatPayProvider implements PaymentProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async queryOrder() {
    return mockSuccess({ paid: false })
  }
}
