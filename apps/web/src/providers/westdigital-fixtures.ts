import type {
  WestDigitalReadTransport,
  WestDigitalTransportRequest,
  WestDigitalTransportResponse,
} from './westdigital'

export const WESTDIGITAL_AVAILABILITY_FIXTURE = {
  clientid: '73550017258015308767',
  data: [{ avail: 1, name: 'ceo.top', price: 3181, type: 'premium' }],
  result: 200,
} as const

export const WESTDIGITAL_PRICE_FIXTURE = {
  clientid: '84803157253633128125',
  data: { buyprice: 29, buyyear: '1', proid: 'domcn', renewprice: 35 },
  result: 200,
} as const

export type WestDigitalFixtureHandler = (
  request: WestDigitalTransportRequest,
) => Promise<WestDigitalTransportResponse> | WestDigitalTransportResponse

export class FixtureWestDigitalTransport implements WestDigitalReadTransport {
  readonly requests: Array<Omit<WestDigitalTransportRequest, 'signal'>> = []

  constructor(private readonly handler: WestDigitalFixtureHandler = defaultHandler) {}

  async execute(request: WestDigitalTransportRequest): Promise<WestDigitalTransportResponse> {
    this.requests.push({
      body: { ...request.body },
      operation: request.operation,
      path: request.path,
      requestId: request.requestId,
    })
    return this.handler(request)
  }
}

function defaultHandler(request: WestDigitalTransportRequest): WestDigitalTransportResponse {
  if (request.operation === 'availability') {
    const domain = request.body.domain
    const suffix = request.body.suffix
    const name = `${domain}${suffix}`

    if (domain === 'ratelimited') {
      return { body: { result: 429 }, headers: { 'retry-after': '12' }, status: 429 }
    }
    if (domain === 'failed' || (domain === 'partial' && suffix === '.xyz')) {
      return { body: { result: 500 }, status: 200 }
    }
    if (name === 'ceo.top') return { body: WESTDIGITAL_AVAILABILITY_FIXTURE, status: 200 }
    if (name === 'premium.top') {
      return {
        body: {
          clientid: 'fixture-premium-request',
          data: [{ avail: 1, name, price: 3181, type: 'premium' }],
          result: 200,
        },
        status: 200,
      }
    }
    if (name === 'taken.cn' || name === 'reserved.net' || name === 'ambiguous.com') {
      return {
        body: { clientid: 'fixture-unavailable-request', data: [{ avail: 0, name }], result: 200 },
        status: 200,
      }
    }

    return {
      body: { clientid: 'fixture-available-request', data: [{ avail: 1, name }], result: 200 },
      status: 200,
    }
  }

  if (
    request.operation === 'price' &&
    request.body.value === 'west.cn' &&
    request.body.year === '1'
  )
    return { body: WESTDIGITAL_PRICE_FIXTURE, status: 200 }

  return { body: { result: 500 }, status: 200 }
}
