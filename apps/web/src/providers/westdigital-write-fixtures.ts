import { getEnv } from '@/lib/env'

import {
  WestDigitalWriteAdapter,
  WestDigitalWriteTransportError,
  type WestDigitalWriteTransport,
  type WestDigitalWriteTransportRequest,
  type WestDigitalWriteTransportResponse,
} from './westdigital-write'

export type WestDigitalWriteFixtureHandler = (
  input: WestDigitalWriteTransportRequest,
) => Promise<WestDigitalWriteTransportResponse> | WestDigitalWriteTransportResponse

export class FixtureWestDigitalWriteTransport implements WestDigitalWriteTransport {
  readonly requests: Array<Omit<WestDigitalWriteTransportRequest, 'signal'>> = []

  constructor(private readonly handler: WestDigitalWriteFixtureHandler = defaultFixture) {}

  async execute(input: WestDigitalWriteTransportRequest): Promise<WestDigitalWriteTransportResponse> {
    this.requests.push({
      body: { ...input.body },
      operation: input.operation,
      path: input.path,
      requestId: input.requestId,
      traceId: input.traceId,
    })
    return this.handler(input)
  }

  get writeCount(): number {
    return this.requests.filter((request) =>
      ['nameserver', 'realname_create', 'register', 'renew'].includes(request.operation),
    ).length
  }
}

function defaultFixture(input: WestDigitalWriteTransportRequest): WestDigitalWriteTransportResponse {
  const clientid = `fixture-${input.requestId}`
  if (input.operation === 'realname_create') {
    return { body: { clientid, data: { c_sysid: 1664777 }, result: 200 }, status: 200 }
  }
  if (input.operation === 'realname_query') {
    return {
      body: {
        clientid,
        data: { c_status: 0, r_status: 0, r_statusname: '审核中', status_name: '审核中' },
        result: 200,
      },
      status: 200,
    }
  }
  if (input.operation === 'register') {
    return {
      body: { clientid, data: { [input.body.domain!]: 200 }, result: 200 },
      status: 200,
    }
  }
  if (input.operation === 'renew' || input.operation === 'nameserver') {
    return { body: { clientid, result: 200 }, status: 200 }
  }
  return {
    body: {
      clientid,
      data: {
        dns1: 'ns1.myhostadmin.net',
        dns2: 'ns2.myhostadmin.net',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain: input.body.domain,
        expdate: '2027-08-08 12:00:00',
        id: '44169980',
        regdate: '2026-08-08 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

export function createConfiguredWestDigitalWriteAdapter(): WestDigitalWriteAdapter {
  if (getEnv().ALLOW_REAL_PROVIDER_WRITES) {
    throw new Error('真实西部数码写 transport 未提供；必须保持 ALLOW_REAL_PROVIDER_WRITES=false')
  }
  return new WestDigitalWriteAdapter({ transport: new FixtureWestDigitalWriteTransport() })
}

export function retryableBeforeSubmission(): never {
  throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
}

export function timeoutAfterSubmission(): never {
  throw new WestDigitalWriteTransportError('TIMEOUT', 'unknown')
}
