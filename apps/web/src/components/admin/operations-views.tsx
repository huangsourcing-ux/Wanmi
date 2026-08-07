import type { AdminViewProps, PayloadRequest } from 'payload'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { canViewOperationsView, type OperationsViewKey } from '@/lib/operations-views'
import {
  readAdvertisingOperationsSnapshot,
  readAuditOperationsSnapshot,
  readContentOperationsSnapshot,
  readFeedbackOperationsSnapshot,
  readTldPricingOperationsSnapshot,
  readToolOperationsSnapshot,
  type OperationsCountGroup,
  type ToolOperationsSnapshot,
} from '@/services/operations/read-operations-views'

type AdminUser = NonNullable<PayloadRequest['user']>

const DURATION_LABELS = {
  '100_299ms': '100–299 ms',
  '1000_2999ms': '1–2.999 s',
  '3000_9999ms': '3–9.999 s',
  '300_999ms': '300–999 ms',
  gte_10000ms: '≥ 10 s',
  lt_100ms: '< 100 ms',
} as const

function requireView(props: AdminViewProps, key: OperationsViewKey): AdminUser {
  const user = (props.user ?? props.initPageResult.req.user) as AdminUser | undefined
  if (!canViewOperationsView(user, key)) notFound()
  return user as AdminUser
}

function OperationsPage({
  children,
  description,
  title,
}: {
  children: React.ReactNode
  description: string
  title: string
}) {
  return (
    <main className="wanmi-operations-view">
      <header className="wanmi-operations-view__header">
        <p className="wanmi-operations-view__eyebrow">Wanmi.AI 运营后台</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </main>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="wanmi-operations-view__empty">{children}</p>
}

function CountGroups({ groups }: { groups: OperationsCountGroup[] }) {
  return (
    <div className="wanmi-operations-grid">
      {groups.map((group) => (
        <section className="wanmi-operations-card" key={group.href}>
          <div className="wanmi-operations-card__heading">
            <h2>{group.label}</h2>
            <strong>{group.total}</strong>
          </div>
          <dl className="wanmi-operations-statuses">
            {group.statuses.map((entry) => (
              <div key={entry.status}>
                <dt>{entry.status}</dt>
                <dd>{entry.count}</dd>
              </div>
            ))}
          </dl>
          <Link className="wanmi-operations-link" href={group.href}>
            打开原生列表
          </Link>
        </section>
      ))}
    </div>
  )
}

function SummaryCards({ snapshot }: { snapshot: ToolOperationsSnapshot }) {
  const items = [
    ['请求量', snapshot.totals.requestCount.toLocaleString('zh-CN')],
    ['成功率', `${(snapshot.totals.successRateBasisPoints / 100).toFixed(2)}%`],
    ['P50', snapshot.totals.p50Bucket ? DURATION_LABELS[snapshot.totals.p50Bucket] : '暂无样本'],
    ['P95', snapshot.totals.p95Bucket ? DURATION_LABELS[snapshot.totals.p95Bucket] : '暂无样本'],
  ] as const
  return (
    <dl className="wanmi-operations-summary">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ToolMetricsTable({ snapshot }: { snapshot: ToolOperationsSnapshot }) {
  if (!snapshot.toolMetrics.length) return <EmptyState>最近 24 小时没有工具终态聚合。</EmptyState>
  return (
    <div className="wanmi-operations-table-wrap">
      <table>
        <thead>
          <tr>
            <th>工具</th>
            <th>请求</th>
            <th>成功</th>
            <th>失败</th>
            <th>成功率</th>
            <th>P50</th>
            <th>P95</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.toolMetrics.map((metric) => (
            <tr key={metric.tool}>
              <th>{metric.tool}</th>
              <td>{metric.requestCount}</td>
              <td>{metric.successCount}</td>
              <td>{metric.failureCount}</td>
              <td>{(metric.successRateBasisPoints / 100).toFixed(2)}%</td>
              <td>{metric.p50Bucket ? DURATION_LABELS[metric.p50Bucket] : '—'}</td>
              <td>{metric.p95Bucket ? DURATION_LABELS[metric.p95Bucket] : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ProviderMetricsTable({ snapshot }: { snapshot: ToolOperationsSnapshot }) {
  if (!snapshot.providerMetrics.length)
    return <EmptyState>最近 24 小时没有 provider 聚合。</EmptyState>
  return (
    <div className="wanmi-operations-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Provider / 操作</th>
            <th>完成请求</th>
            <th>超时</th>
            <th>限频</th>
            <th>上游错误</th>
            <th>无效响应</th>
            <th>当前 / 最大队列</th>
            <th>拒绝</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.providerMetrics.map((metric) => (
            <tr key={`${metric.provider}:${metric.operation}`}>
              <th>
                {metric.provider} / {metric.operation}
              </th>
              <td>{metric.requestCount}</td>
              <td>{metric.timeoutErrorCount}</td>
              <td>{metric.rateLimitedErrorCount}</td>
              <td>{metric.upstreamErrorCount}</td>
              <td>{metric.invalidResponseErrorCount}</td>
              <td>
                {metric.lastQueueDepth} / {metric.maxQueueDepth}
              </td>
              <td>{metric.rejectedCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export async function OperationsDashboardView(props: AdminViewProps) {
  const user = requireView(props, 'dashboard')
  const snapshot = await readToolOperationsSnapshot(props.payload, user)
  return (
    <OperationsPage
      description="最近 24 小时的第一方工具聚合。数据来自 D2-11 小时桶，不读取或展示原始事件、完整查询域名或用户标识。"
      title="基础运营仪表盘"
    >
      <SummaryCards snapshot={snapshot} />
      <section className="wanmi-operations-panel">
        <div className="wanmi-operations-panel__heading">
          <h2>六类工具</h2>
          <Link href="/admin/operations/tools">查看完整工具状态</Link>
        </div>
        <ToolMetricsTable snapshot={snapshot} />
      </section>
      <section className="wanmi-operations-panel">
        <h2>Provider 错误与队列状态</h2>
        <ProviderMetricsTable snapshot={snapshot} />
      </section>
      <p className="wanmi-operations-view__footnote">
        时间窗：{new Date(snapshot.since).toLocaleString('zh-CN')} 至{' '}
        {new Date(snapshot.generatedAt).toLocaleString('zh-CN')}；读取 {snapshot.bucketCount}{' '}
        个小时聚合桶。
      </p>
    </OperationsPage>
  )
}

export async function ToolStatusView(props: AdminViewProps) {
  const user = requireView(props, 'tools')
  const snapshot = await readToolOperationsSnapshot(props.payload, user)
  return (
    <OperationsPage
      description="只读展示六类工具与 provider 的最近 24 小时聚合状态。"
      title="工具状态"
    >
      <SummaryCards snapshot={snapshot} />
      <section className="wanmi-operations-panel">
        <h2>工具请求与延迟</h2>
        <ToolMetricsTable snapshot={snapshot} />
      </section>
      <section className="wanmi-operations-panel">
        <h2>Provider 错误与队列</h2>
        <ProviderMetricsTable snapshot={snapshot} />
      </section>
    </OperationsPage>
  )
}

export async function ContentOperationsView(props: AdminViewProps) {
  const user = requireView(props, 'content')
  const groups = await readContentOperationsSnapshot(props.payload, user)
  return (
    <OperationsPage
      description="按现有内容工作流汇总文章、专题、帮助和 TLD 页面。"
      title="内容运营"
    >
      <CountGroups groups={groups} />
    </OperationsPage>
  )
}

export async function AdvertisingOperationsView(props: AdminViewProps) {
  const user = requireView(props, 'advertising')
  const groups = await readAdvertisingOperationsSnapshot(props.payload, user)
  return (
    <OperationsPage
      description="广告主、素材和排期状态汇总；分析角色读取时继续应用字段级脱敏。"
      title="广告运营"
    >
      <CountGroups groups={groups} />
    </OperationsPage>
  )
}

export async function TldPricingOperationsView(props: AdminViewProps) {
  const user = requireView(props, 'tldPricing')
  const snapshot = await readTldPricingOperationsSnapshot(props.payload, user)
  return (
    <OperationsPage
      description="TLD 内容状态与价格快照使用各自既有权限，不扩大价格可见范围。"
      title="TLD / 价格"
    >
      <section className="wanmi-operations-panel">
        <div className="wanmi-operations-panel__heading">
          <h2>TLD 页面</h2>
          <Link href="/admin/collections/tldPages">打开原生列表</Link>
        </div>
        {snapshot.tlds.length ? (
          <div className="wanmi-operations-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>TLD</th>
                  <th>标题</th>
                  <th>内容状态</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.tlds.map((tld) => (
                  <tr key={tld.id}>
                    <th>.{tld.slug}</th>
                    <td>{tld.title}</td>
                    <td>{tld.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>暂无可见 TLD 页面。</EmptyState>
        )}
      </section>
      <section className="wanmi-operations-panel">
        <div className="wanmi-operations-panel__heading">
          <h2>最新价格快照</h2>
          {snapshot.pricingVisible ? (
            <Link href="/admin/collections/priceSnapshots">打开原生列表</Link>
          ) : null}
        </div>
        {!snapshot.pricingVisible ? (
          <EmptyState>价格成本与规则仅 system_admin 可见。</EmptyState>
        ) : snapshot.latestPrices.length ? (
          <div className="wanmi-operations-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>TLD</th>
                  <th>注册</th>
                  <th>续费</th>
                  <th>取价时间</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.latestPrices.map((price) => (
                  <tr key={price.tld}>
                    <th>.{price.tld}</th>
                    <td>¥{(price.registrationPriceMinor / 100).toFixed(2)}</td>
                    <td>¥{(price.renewalPriceMinor / 100).toFixed(2)}</td>
                    <td>{new Date(price.observedAt).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>暂无价格快照。</EmptyState>
        )}
      </section>
    </OperationsPage>
  )
}

export async function FeedbackOperationsView(props: AdminViewProps) {
  const user = requireView(props, 'feedback')
  const feedback = await readFeedbackOperationsSnapshot(props.payload, user)
  return (
    <OperationsPage
      description="只显示清洗摘要和掩码联系方式；原始提交内容与客户端哈希不在此视图展示。"
      title="反馈运营"
    >
      <section className="wanmi-operations-panel">
        <div className="wanmi-operations-panel__heading">
          <h2>最近反馈</h2>
          <Link href="/admin/collections/form-submissions">打开原生列表</Link>
        </div>
        {feedback.length ? (
          <div className="wanmi-operations-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>摘要</th>
                  <th>联系</th>
                  <th>工具</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {feedback.map((entry) => (
                  <tr key={entry.id}>
                    <th>
                      <Link href={`/admin/collections/form-submissions/${entry.id}`}>
                        {entry.purpose}
                      </Link>
                    </th>
                    <td>{entry.summary}</td>
                    <td>{entry.contactMasked ?? '—'}</td>
                    <td>{entry.tool ?? '—'}</td>
                    <td>{entry.status}</td>
                    <td>{new Date(entry.createdAt).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>暂无可见反馈。</EmptyState>
        )}
      </section>
    </OperationsPage>
  )
}

export async function AuditOperationsView(props: AdminViewProps) {
  const user = requireView(props, 'audit')
  const audits = await readAuditOperationsSnapshot(props.payload, user)
  return (
    <OperationsPage
      description="system_admin 查看全量；ad_operator 只看到本人管理员事件；analyst 无入口且服务端拒绝。"
      title="审计浏览"
    >
      <section className="wanmi-operations-panel">
        <div className="wanmi-operations-panel__heading">
          <h2>最近审计事件</h2>
          <Link href="/admin/collections/auditLogs">打开原生列表</Link>
        </div>
        {audits.length ? (
          <div className="wanmi-operations-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>动作</th>
                  <th>操作者类型</th>
                  <th>目标类型</th>
                  <th>目标</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {audits.map((entry) => (
                  <tr key={entry.id}>
                    <th>
                      <Link href={`/admin/collections/auditLogs/${entry.id}`}>{entry.action}</Link>
                    </th>
                    <td>{entry.actorType}</td>
                    <td>{entry.targetType}</td>
                    <td>{entry.targetId ?? '—'}</td>
                    <td>{new Date(entry.createdAt).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>暂无可见审计事件。</EmptyState>
        )}
      </section>
    </OperationsPage>
  )
}
