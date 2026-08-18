import { getEnv } from '@/lib/env'
import { assertLiveRuntimeTransportAllowed } from '@/lib/provider-write-guardrails'
import { LiveWestDigitalTransport } from '@/providers/westdigital-live'

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
  private readonly handler: WestDigitalWriteFixtureHandler

  constructor(handler?: WestDigitalWriteFixtureHandler) {
    this.handler = handler ?? createDefaultFixture()
  }

  async execute(
    input: WestDigitalWriteTransportRequest,
  ): Promise<WestDigitalWriteTransportResponse> {
    this.requests.push({
      body: { ...input.body },
      operation: input.operation,
      path: input.path,
      requestId: input.requestId,
      traceId: input.traceId,
    })
    if (isWriteOperation(input.operation)) {
      await interruptValidationDelay(input.signal)
    }
    return this.handler(input)
  }

  get writeCount(): number {
    return this.requests.filter((request) => isWriteOperation(request.operation)).length
  }
}

function isWriteOperation(operation: WestDigitalWriteTransportRequest['operation']): boolean {
  return [
    'dns_record_add',
    'dns_record_delete',
    'dns_record_modify',
    'dns_record_pause',
    'offline_dns_record_delete_submit',
    'domain_contact_update',
    'domain_lock',
    'domain_management_password_modify',
    'domain_template_transfer',
    'nameserver',
    'realname_create',
    'register',
    'renew',
  ].includes(operation)
}

async function interruptValidationDelay(signal: AbortSignal): Promise<void> {
  const raw = process.env.WANMI_D7_FIXTURE_DELAY_MS
  if (raw === undefined || raw === '' || raw === '0') return
  if (
    process.env.WANMI_D7_REBUILD_VALIDATION !== 'D7-07-LOCAL-ONLY' ||
    /^(?:1|true)$/iu.test(process.env.ALLOW_REAL_PROVIDER_WRITES ?? '')
  ) {
    throw new Error('D7-07 fixture delay is restricted to local write-disabled validation')
  }
  const milliseconds = Number(raw)
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) {
    throw new Error('WANMI_D7_FIXTURE_DELAY_MS must be 1..60000')
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new Error('D7-07 fixture delay aborted'))
      },
      { once: true },
    )
  })
}

function createDefaultFixture(): WestDigitalWriteFixtureHandler {
  const records = new Map<string, Record<string, string>>()
  const managementPasswords = new Map<string, string>()
  const templateIds = new Map<string, string>()
  const offlineTasks = new Map<string, { domainAscii: string; taskSku: string }>()
  let nextRecordId = 900_001
  return (input): WestDigitalWriteTransportResponse => {
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
    if (
      input.operation === 'renew' ||
      input.operation === 'nameserver' ||
      input.operation === 'domain_lock'
    ) {
      return { body: { clientid, result: 200 }, status: 200 }
    }
    if (input.operation === 'domain_management_password_get') {
      return {
        body: {
          clientid,
          data: {
            domainpwd: managementPasswords.get(input.body.domain!) ?? 'fixture-domain-password',
          },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'domain_management_password_modify') {
      managementPasswords.set(input.body.domain!, input.body.domainpwd!)
      return { body: { clientid, result: 200 }, status: 200 }
    }
    if (input.operation === 'domain_contact_update') {
      return { body: { clientid, data: {}, result: 200 }, status: 200 }
    }
    if (input.operation === 'domain_template_transfer') {
      templateIds.set(input.body.domain!, input.body.c_sysid!)
      return {
        body: {
          clientid,
          data: {
            [input.body.domain!]: {
              admin_id: { result: 200 },
              bill_id: { result: 200 },
              dom_id: { result: 200 },
              tech_id: { result: 200 },
            },
            c_sysid: Number(input.body.c_sysid),
          },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'domain_information_query') {
      return {
        body: {
          clientid,
          data: {
            c_sysid: Number(templateIds.get(input.body.domain!) ?? '1664777'),
            domain: input.body.domain,
          },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'domain_certificate_get') {
      return {
        body: {
          clientid,
          data: { certurl: Buffer.from('fixture-domain-certificate').toString('base64') },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'dns_record_add') {
      const id = String(nextRecordId++)
      records.set(id, { ...input.body, id, pause: '0' })
      return { body: { clientid, data: { id }, result: 200 }, status: 200 }
    }
    if (input.operation === 'dns_record_modify') {
      const current = records.get(input.body.id!)
      if (current) records.set(input.body.id!, { ...current, ...input.body })
      return { body: { clientid, result: current ? 200 : 404 }, status: 200 }
    }
    if (input.operation === 'dns_record_delete') {
      const deleted = records.delete(input.body.id!)
      return { body: { clientid, result: deleted ? 200 : 404 }, status: 200 }
    }
    if (input.operation === 'dns_record_pause') {
      const current = records.get(input.body.id!)
      if (current) records.set(input.body.id!, { ...current, pause: input.body.val! })
      return { body: { clientid, result: current ? 200 : 404 }, status: 200 }
    }
    if (input.operation === 'dns_record_query') {
      const items = [...records.values()]
        .filter(
          (record) =>
            (!input.body.host || record.host === input.body.host) &&
            (!input.body.type || record.type === input.body.type) &&
            (!input.body.value || record.value === input.body.value),
        )
        .map((record) => ({
          id: record.id,
          item: record.host,
          level: Number(record.level),
          line: record.line,
          pause: Number(record.pause),
          ttl: Number(record.ttl),
          type: record.type,
          value: record.value,
        }))
      const limit = Number(input.body.limit)
      const pageno = Number(input.body.pageno)
      return {
        body: {
          clientid,
          data: {
            items,
            limit,
            pagecount: items.length ? 1 : 0,
            pageno,
            total: items.length,
          },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'offline_dns_record_delete_submit') {
      const taskSku = `TASK-${input.requestId}`
      offlineTasks.set(taskSku, {
        domainAscii: input.body.data!.split('|', 1)[0]!,
        taskSku,
      })
      return {
        body: { clientid, code: 200, data: { task_sku: taskSku }, msg: '成功' },
        status: 200,
      }
    }
    if (input.operation === 'offline_task_list') {
      const task = offlineTasks.get(input.body.task_sku!)
      return {
        body: {
          clientid,
          code: 200,
          data: {
            data: task
              ? [
                  {
                    task_act: 'dodelreall',
                    task_sku: task.taskSku,
                    task_state: 1,
                    task_type: 'dns_record',
                  },
                ]
              : [],
            page: 1,
            pageSize: 10,
            totalCount: task ? 1 : 0,
          },
          msg: '成功',
        },
        status: 200,
      }
    }
    if (input.operation === 'offline_task_record_list') {
      const task = offlineTasks.get(input.body.task_sku!)
      return {
        body: {
          clientid,
          code: 200,
          data: {
            data: task
              ? [
                  {
                    act: 'dodelreall',
                    record_ident: task.domainAscii,
                    record_result: '队列中',
                    record_state: 6,
                  },
                ]
              : [],
            page: 1,
            pageSize: 10,
            stat: task ? [{ num: '1', record_state: '6' }] : [],
            totalCount: task ? 1 : 0,
          },
          msg: '成功',
        },
        status: 200,
      }
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
}

export function createConfiguredWestDigitalWriteAdapter(
  options: {
    liveTransportFactory?: () => WestDigitalWriteTransport
  } = {},
): WestDigitalWriteAdapter {
  const env = getEnv()
  if (env.WESTDIGITAL_MODE === 'fixture') {
    return new WestDigitalWriteAdapter({
      timeoutMs: env.WESTDIGITAL_READ_TIMEOUT_MS,
      transport: new FixtureWestDigitalWriteTransport(),
    })
  }
  if (
    !env.ALLOW_REAL_PROVIDER_WRITES ||
    !env.ALLOW_REAL_WESTDIGITAL ||
    !env.ALLOW_REAL_WESTDIGITAL_READS
  ) {
    throw new Error(
      'West Digital live mode requires the total, provider, and read-query safety gates',
    )
  }
  assertLiveRuntimeTransportAllowed('westdigital')
  const transport = options.liveTransportFactory
    ? options.liveTransportFactory()
    : new LiveWestDigitalTransport()
  return new WestDigitalWriteAdapter({
    timeoutMs: env.WESTDIGITAL_READ_TIMEOUT_MS,
    transport,
  })
}

export function retryableBeforeSubmission(): never {
  throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
}

export function timeoutAfterSubmission(): never {
  throw new WestDigitalWriteTransportError('TIMEOUT', 'unknown')
}
