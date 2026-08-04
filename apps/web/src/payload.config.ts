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

const env = getEnv()
const configDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(configDir, '..')
const serverOrigin = new URL(env.NEXT_PUBLIC_SERVER_URL).origin

const storagePlugin = s3Storage({
  acl: 'private',
  alwaysInsertFields: true,
  bucket: env.S3_BUCKET ?? 'wanmi-public-schema-placeholder',
  collections: {
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
      collections: ['articles', 'topics', 'tldPages'],
      generateDescription: ({ doc }) => doc.summary ?? '',
      generateTitle: ({ doc }) => doc.title ?? '',
      generateURL: ({ collectionConfig, doc }) =>
        `${serverOrigin}/${collectionConfig?.slug ?? 'content'}/${doc.slug ?? ''}`,
      tabbedUI: true,
      uploadsCollection: 'media',
    }),
    redirectsPlugin({
      collections: ['articles', 'topics', 'tldPages'],
      overrides: redirectsOverrides,
      redirectTypes: ['301', '302'],
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
