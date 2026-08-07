import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { formBuilderPlugin } from '@payloadcms/plugin-form-builder'
import { redirectsPlugin } from '@payloadcms/plugin-redirects'
import { seoPlugin } from '@payloadcms/plugin-seo'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { s3Storage } from '@payloadcms/storage-s3'
import { buildConfig } from 'payload'
import sharp from 'sharp'

import { hasRole } from '@/access/roles'
import { collections } from '@/collections'
import { workflows } from '@/jobs/config'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logging'
import {
  appendFormPurposeField,
  formOverrides,
  formSubmissionOverrides,
  redirectsOverrides,
} from '@/plugins/guards'
import { appendSeoFields, generateSeoPreviewUrl } from '@/plugins/seo'

const env = getEnv()
const configDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(configDir, '..')
const serverOrigin = new URL(env.NEXT_PUBLIC_SERVER_URL).origin

const storagePlugin = s3Storage({
  acl: 'private',
  alwaysInsertFields: true,
  bucket: env.S3_BUCKET ?? 'wanmi-public-schema-placeholder',
  collections: {
    adMedia: {
      prefix: 'public/advertising',
      signedDownloads: { expiresIn: 300 },
    },
    media: {
      prefix: 'public/media',
      signedDownloads: { expiresIn: 300 },
    },
  },
  config: {
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    region: env.S3_REGION,
  },
  disableLocalStorage: env.PUBLIC_STORAGE_MODE === 's3',
  enabled: env.PUBLIC_STORAGE_MODE === 's3',
  useCompositePrefixes: true,
})

export default buildConfig({
  admin: {
    autoRefresh: false,
    components: {
      afterNavLinks: ['@/components/admin/operations-navigation#OperationsNavigation'],
      settingsMenu: ['@/components/admin/security-settings-link#SecuritySettingsLink'],
      views: {
        operationsAdvertising: {
          Component: '@/components/admin/operations-views#AdvertisingOperationsView',
          exact: true,
          meta: { title: '广告运营' },
          path: '/operations/advertising',
        },
        operationsAudit: {
          Component: '@/components/admin/operations-views#AuditOperationsView',
          exact: true,
          meta: { title: '审计浏览' },
          path: '/operations/audit',
        },
        operationsContent: {
          Component: '@/components/admin/operations-views#ContentOperationsView',
          exact: true,
          meta: { title: '内容运营' },
          path: '/operations/content',
        },
        operationsFeedback: {
          Component: '@/components/admin/operations-views#FeedbackOperationsView',
          exact: true,
          meta: { title: '反馈运营' },
          path: '/operations/feedback',
        },
        operationsTldPricing: {
          Component: '@/components/admin/operations-views#TldPricingOperationsView',
          exact: true,
          meta: { title: 'TLD / 价格' },
          path: '/operations/tld-pricing',
        },
        operationsTools: {
          Component: '@/components/admin/operations-views#ToolStatusView',
          exact: true,
          meta: { title: '工具状态' },
          path: '/operations/tools',
        },
        operationsDashboard: {
          Component: '@/components/admin/operations-views#OperationsDashboardView',
          exact: true,
          meta: { title: '运营仪表盘' },
          path: '/operations',
        },
      },
    },
    importMap: {
      baseDir: appDir,
      importMapFile: resolve(configDir, 'app/(payload)/admin/importMap.js'),
    },
    meta: { titleSuffix: ' — Wanmi.AI' },
    user: 'admins',
  },
  collections,
  cookiePrefix: 'wanmi_admin',
  cors: [serverOrigin],
  csrf: [serverOrigin],
  graphQL: { disable: true },
  db: postgresAdapter({
    migrationDir: resolve(appDir, 'migrations'),
    pool: { connectionString: env.DATABASE_URL, max: 10 },
    push: false,
  }),
  editor: lexicalEditor(),
  jobs: {
    access: {
      cancel: ({ req }) => hasRole(req.user, ['system_admin']),
      queue: ({ req }) => hasRole(req.user, ['system_admin']),
      run: ({ req }) => hasRole(req.user, ['system_admin']),
    },
    addParentToTaskLog: true,
    deleteJobOnComplete: false,
    enableConcurrencyControl: true,
    processingOrder: { default: 'createdAt', queues: { commerce: 'createdAt' } },
    workflows,
  },
  logger,
  plugins: [
    seoPlugin({
      collections: ['articles', 'topics', 'tldPages', 'helpPages', 'categories', 'tags'],
      fields: appendSeoFields,
      generateDescription: ({ doc }) => doc.summary ?? doc.description ?? '',
      generateTitle: ({ doc }) => doc.title ?? '',
      generateURL: ({ collectionConfig, doc }) =>
        generateSeoPreviewUrl(collectionConfig?.slug, doc.slug),
      interfaceName: 'WanmiSeoMeta',
      tabbedUI: true,
      uploadsCollection: 'media',
    }),
    redirectsPlugin({
      collections: [
        'articles',
        'topics',
        'tldPages',
        'helpPages',
        'categories',
        'tags',
        'toolPages',
      ],
      overrides: redirectsOverrides,
      redirectTypes: ['301'],
    }),
    formBuilderPlugin({
      fields: {
        checkbox: true,
        country: false,
        date: false,
        email: true,
        message: true,
        number: true,
        payment: false,
        select: true,
        state: false,
        text: true,
        textarea: true,
        upload: false,
      },
      formOverrides: { ...formOverrides, fields: appendFormPurposeField },
      formSubmissionOverrides,
      redirectRelationships: ['articles', 'topics', 'tldPages'],
    }),
    storagePlugin,
  ],
  secret: env.PAYLOAD_SECRET,
  serverURL: env.NEXT_PUBLIC_SERVER_URL,
  sharp,
  typescript: {
    outputFile: resolve(configDir, 'payload-types.ts'),
  },
})
