import { createOpenGraphImage } from '@/components/seo/open-graph-image'

export const dynamic = 'force-static'

export function GET() {
  return createOpenGraphImage()
}
