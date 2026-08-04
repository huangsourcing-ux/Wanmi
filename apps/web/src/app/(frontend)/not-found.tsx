import { ResultState } from '@/components/results/result-state'

export default function FrontendNotFound() {
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
      <ResultState
        description="这个页面可能已改址、尚未发布，或输入的地址不正确。"
        headingLevel={1}
        primaryAction={{ href: '/tools', label: '前往工具中心' }}
        secondaryAction={{ href: '/', label: '返回首页' }}
        showContextRequestId
        state="empty"
        suggestedAction="请检查地址，或从首页重新选择需要的工具和内容。"
        title="没有找到这个页面"
      />
    </section>
  )
}
