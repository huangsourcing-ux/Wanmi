import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['ali-oss'],
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
}

export default withPayload(nextConfig)
