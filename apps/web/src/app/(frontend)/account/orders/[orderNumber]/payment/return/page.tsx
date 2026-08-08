import type { Metadata } from 'next'

import { PaymentFlow } from '@/components/commerce/payment-flow'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '核对支付状态',
}

export default async function PaymentReturnPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>
}) {
  const { orderNumber } = await params
  return <PaymentFlow orderNumber={orderNumber} returned />
}
