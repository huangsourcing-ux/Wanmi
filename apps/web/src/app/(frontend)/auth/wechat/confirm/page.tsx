import type { Metadata } from 'next'

import { WechatLoginConfirmation } from './wechat-login-confirmation'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '确认登录 | Wanmi.AI',
}

export default function WechatLoginConfirmationPage() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl items-center px-6 py-16">
      <WechatLoginConfirmation />
    </main>
  )
}
