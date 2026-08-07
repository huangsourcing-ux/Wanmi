import { PublicFormPage } from '@/components/forms/public-form-page'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/contact')

export default function ContactPage() {
  return <PublicFormPage purpose="contact" />
}
