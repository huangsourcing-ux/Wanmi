import type { Metadata } from 'next'

import { PaymentFlow } from '@/components/commerce/payment-flow'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '微信支付',
}

export default async function PaymentPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>
}) {
  const { orderNumber } = await params
  return <PaymentFlow orderNumber={orderNumber} />
}
