import { PublicFormPage } from '@/components/forms/public-form-page'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/requests')

export default function RequestsPage() {
  return <PublicFormPage purpose="request" />
}
