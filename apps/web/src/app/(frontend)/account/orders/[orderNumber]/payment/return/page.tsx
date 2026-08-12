import type { Metadata } from 'next'

import { PaymentFlow } from '@/components/commerce/payment-flow'
import { getPublicComplianceConfig } from '@/lib/public-compliance'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '核对支付状态',
}

export default async function PaymentReturnPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>
}) {
  const [{ orderNumber }, compliance] = await Promise.all([params, getPublicComplianceConfig()])
  return <PaymentFlow orderNumber={orderNumber} registrarName={compliance.registrarName} returned />
}
