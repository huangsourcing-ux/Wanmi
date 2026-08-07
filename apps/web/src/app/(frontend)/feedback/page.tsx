import { PublicFormPage } from '@/components/forms/public-form-page'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/feedback')

export default function FeedbackPage() {
  return <PublicFormPage purpose="feedback" />
}
