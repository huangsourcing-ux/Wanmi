import config from '@payload-config'
import { getPayload } from 'payload'

import { PublicFormView } from '@/components/forms/public-form'
import { ResultState } from '@/components/results/result-state'
import { PageIntro } from '@/components/site/page-intro'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { logger } from '@/lib/logging'
import type { PublicFormPurpose } from '@/schemas/forms'
import { readManagedPublicForm } from '@/services/forms/read-public-form'

const pageCopy = {
  contact: {
    badge: '联系入口',
    description: '用于一般咨询、内容合作、广告合作和其他非交易事项。',
    title: '联系 Wanmi',
  },
  feedback: {
    badge: '反馈入口',
    description: '反馈工具结果、内容问题或使用体验；提供请求 ID 有助于定位问题。',
    title: '提交反馈',
  },
  request: {
    badge: '需求收集',
    description: '告诉我们希望增加的工具、TLD 信息、内容选题或合作能力。',
    title: '提交需求',
  },
} as const satisfies Record<
  PublicFormPurpose,
  { badge: string; description: string; title: string }
>

export async function PublicFormPage({ purpose }: { purpose: PublicFormPurpose }) {
  const copy = pageCopy[purpose]
  let form
  let failed = false
  try {
    form = await readManagedPublicForm(await getPayload({ config }), purpose)
  } catch (error) {
    failed = true
    logger.warn({
      errorName: error instanceof Error ? error.name : 'UnknownError',
      msg: 'Public form read failed',
      purpose,
    })
  }

  return (
    <>
      <PageIntro badge={copy.badge} description={copy.description} title={copy.title} />
      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>{form?.title ?? copy.title}</CardTitle>
              <CardDescription>
                必填项以 * 标注。提交成功后页面会显示请求 ID；失败或限流不会伪装成成功。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {form ? <PublicFormView form={form} /> : null}
              {!form && failed ? (
                <ResultState
                  description="当前无法读取表单配置，未保存任何内容。"
                  retryable
                  state="degraded"
                  suggestedAction="请稍后刷新页面"
                  title="表单暂时不可用"
                />
              ) : null}
              {!form && !failed ? (
                <ResultState
                  description="当前用途尚未配置可用表单。"
                  state="empty"
                  title="表单尚未开放"
                />
              ) : null}
            </CardContent>
          </Card>
          <Card className="h-fit bg-muted/40">
            <CardHeader>
              <CardTitle>提交边界</CardTitle>
              <CardDescription className="leading-6">
                本入口不处理订单、支付、退款、实名或文件上传，也不会把查询参数中的完整域名作为表单字段保存。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
              <p>请勿填写证件号码、支付凭据、验证码、Cookie、密码或其他秘密。</p>
              <p>
                联系方式属于敏感字段，仅系统管理员可查看原值；运营与分析角色只能看到掩码和清洗后的摘要。
              </p>
              <p>文本只按纯文本保存；HTML 会被拒绝，正文中的完整域名会被隐藏。</p>
            </CardContent>
          </Card>
        </div>
      </section>
    </>
  )
}
