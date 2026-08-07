import {
  BlockquoteFeature,
  BoldFeature,
  FixedToolbarFeature,
  HeadingFeature,
  InlineCodeFeature,
  InlineToolbarFeature,
  ItalicFeature,
  LinkFeature,
  OrderedListFeature,
  ParagraphFeature,
  UnderlineFeature,
  UnorderedListFeature,
  UploadFeature,
  lexicalEditor,
} from '@payloadcms/richtext-lexical'
import type {
  Access,
  CollectionBeforeChangeHook,
  CollectionConfig,
  Field,
  FieldAccess,
  Where,
} from 'payload'

import {
  contentAdminHidden,
  contentManagers,
  deny,
  hasRole,
  publishedOrContentManager,
  publicRead,
  systemAdminHidden,
  systemAdminOnly,
} from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'
import { sanitizeRichText } from '@/services/content/rich-text'
import {
  CONTENT_WORKFLOW_CONTEXT,
  CONTENT_WORKFLOW_STATUSES,
  PUBLIC_CONTENT_RELATIONS_CONTEXT,
  PUBLIC_TAXONOMY_CONTEXT,
  PUBLIC_TAXONOMY_ROUTE_CONTEXT,
  type ContentCollection,
  type ContentWorkflowStatus,
  isContentWorkflowStatus,
} from '@/services/content/types'

const slugFields: Field[] = [
  { name: 'title', type: 'text', required: true },
  { name: 'slug', type: 'text', index: true, required: true, unique: true },
  { name: 'summary', type: 'textarea' },
]

const contentEditor = lexicalEditor({
  features: () => [
    ParagraphFeature(),
    HeadingFeature({ enabledHeadingSizes: ['h2', 'h3', 'h4'] }),
    BoldFeature(),
    ItalicFeature(),
    UnderlineFeature(),
    InlineCodeFeature(),
    OrderedListFeature(),
    UnorderedListFeature(),
    BlockquoteFeature(),
    LinkFeature({ disableAutoLinks: true, enabledCollections: [] }),
    UploadFeature({ enabledCollections: ['media'], maxDepth: 1 }),
    FixedToolbarFeature(),
    InlineToolbarFeature(),
  ],
})

const workflowFieldAccess: FieldAccess = ({ req }) =>
  Boolean(req.context?.[CONTENT_WORKFLOW_CONTEXT]) &&
  hasRole(req.user, ['content_editor', 'system_admin'])

const taxonomyRead: Access = ({ req }) => {
  if (hasRole(req.user, ['content_editor', 'system_admin'])) return true
  const ids = req.context?.[PUBLIC_TAXONOMY_CONTEXT]
  if (Array.isArray(ids) && ids.length) {
    const where: Where = {
      id: {
        in: ids.filter((id): id is number | string => ['number', 'string'].includes(typeof id)),
      },
    }
    return where
  }
  const routeSlug = req.context?.[PUBLIC_TAXONOMY_ROUTE_CONTEXT]
  if (typeof routeSlug === 'string' && routeSlug) {
    const where: Where = { slug: { equals: routeSlug } }
    return where
  }
  return false
}

const relationRead: FieldAccess = ({ req }) =>
  hasRole(req.user, ['content_editor', 'system_admin']) ||
  req.context?.[PUBLIC_CONTENT_RELATIONS_CONTEXT] === true

const relatedToolsField: Field = {
  name: 'relatedTools',
  type: 'relationship',
  access: { read: relationRead },
  admin: { allowCreate: false },
  hasMany: true,
  maxDepth: 0,
  relationTo: 'toolPages',
}

const relatedTldPagesField: Field = {
  name: 'relatedTldPages',
  type: 'relationship',
  access: { read: relationRead },
  admin: { allowCreate: false },
  hasMany: true,
  maxDepth: 0,
  relationTo: 'tldPages',
}

const relatedContentJoinFields = (
  on: 'relatedTldPages' | 'relatedTools',
): Field[] =>
  ([
    ['relatedArticles', 'articles'],
    ['relatedTopics', 'topics'],
    ['relatedHelpPages', 'helpPages'],
  ] as const).map(([name, collection]) => ({
    name,
    type: 'join',
    access: {
      read: ({ req }) => hasRole(req.user, ['content_editor', 'system_admin']),
    },
    admin: {
      allowCreate: true,
      defaultColumns: ['title', 'workflowStatus', 'publishedAt', 'updatedAt'],
    },
    collection,
    defaultLimit: 20,
    maxDepth: 0,
    on,
  }))

function currentWorkflowStatus(originalDoc: unknown): ContentWorkflowStatus {
  if (
    typeof originalDoc === 'object' &&
    originalDoc !== null &&
    isContentWorkflowStatus((originalDoc as Record<string, unknown>).workflowStatus)
  ) {
    return (originalDoc as Record<string, unknown>).workflowStatus as ContentWorkflowStatus
  }
  return 'draft'
}

const guardAndSanitizeContent: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const workflowOperation = Boolean(req.context?.[CONTENT_WORKFLOW_CONTEXT])
  const actorIsContentManager = hasRole(req.user, ['content_editor', 'system_admin'])
  const originalStatus = currentWorkflowStatus(originalDoc)

  if (operation === 'update' && originalStatus === 'archived' && !workflowOperation) {
    throw new AppError('CONTENT_ARCHIVED_READ_ONLY', '已归档内容不可修改', 409)
  }

  if (data.content !== undefined) data.content = sanitizeRichText(data.content)
  if (typeof data.source === 'string') data.source = data.source.trim()

  if (actorIsContentManager && !workflowOperation) {
    data.workflowStatus = operation === 'create' ? 'draft' : originalStatus
    data.scheduledPublishAt =
      operation === 'create'
        ? null
        : (originalDoc as Record<string, unknown> | undefined)?.scheduledPublishAt
    data.publishedAt =
      operation === 'create'
        ? null
        : (originalDoc as Record<string, unknown> | undefined)?.publishedAt
    data._status = 'draft'
  } else if (!req.user && operation === 'create' && data.workflowStatus === undefined) {
    data.workflowStatus = data._status === 'published' ? 'published' : 'draft'
  }

  if (actorIsContentManager) data.revisionBy = String(req.user?.id)
  return data
}

const versionedContent = (slug: ContentCollection): CollectionConfig => ({
  slug,
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: publishedOrContentManager,
    readVersions: contentManagers,
    update: contentManagers,
  },
  admin: {
    components: {
      edit: {
        beforeDocumentControls: [
          '@/components/admin/content-workflow-controls#ContentWorkflowControls',
        ],
        PreviewButton: '@/components/admin/content-native-action-disabled#DisabledNativeAction',
        PublishButton: '@/components/admin/content-native-action-disabled#DisabledNativeAction',
        UnpublishButton: '@/components/admin/content-native-action-disabled#DisabledNativeAction',
      },
    },
    defaultColumns: ['title', 'workflowStatus', 'publishedAt', 'updatedAt'],
    group: ADMIN_GROUPS.content,
    hidden: contentAdminHidden,
    useAsTitle: 'title',
  },
  fields: [
    ...slugFields,
    { name: 'content', type: 'richText', editor: contentEditor, required: true },
    { name: 'source', type: 'text' },
    {
      name: 'workflowStatus',
      type: 'select',
      access: { create: workflowFieldAccess, update: workflowFieldAccess },
      admin: { readOnly: true },
      defaultValue: 'draft',
      index: true,
      options: [...CONTENT_WORKFLOW_STATUSES],
      required: true,
    },
    {
      name: 'scheduledPublishAt',
      type: 'date',
      access: { create: workflowFieldAccess, update: workflowFieldAccess },
      admin: { readOnly: true },
      index: true,
    },
    {
      name: 'publishedAt',
      type: 'date',
      access: { create: workflowFieldAccess, update: workflowFieldAccess },
      admin: { readOnly: true },
      index: true,
    },
    {
      name: 'revisionBy',
      type: 'text',
      access: {
        create: workflowFieldAccess,
        read: ({ req }) => hasRole(req.user, ['content_editor', 'system_admin']),
        update: workflowFieldAccess,
      },
      admin: { readOnly: true },
    },
    ...(slug === 'articles'
      ? ([
          { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
          { name: 'tags', type: 'relationship', hasMany: true, relationTo: 'tags' },
        ] satisfies Field[])
      : []),
    relatedToolsField,
    ...(slug === 'tldPages'
      ? relatedContentJoinFields('relatedTldPages')
      : ([relatedTldPagesField] satisfies Field[])),
  ],
  hooks: { beforeChange: [guardAndSanitizeContent] },
  versions: {
    drafts: { autosave: true, schedulePublish: false },
    maxPerDoc: 50,
  },
})

export const Articles = versionedContent('articles')
export const Topics = versionedContent('topics')
export const TldPages = versionedContent('tldPages')
export const HelpPages = versionedContent('helpPages')

export const ToolPages: CollectionConfig = {
  slug: 'toolPages',
  access: {
    create: deny,
    delete: deny,
    read: publicRead,
    update: deny,
  },
  admin: {
    defaultColumns: ['title', 'slug', 'href'],
    group: ADMIN_GROUPS.content,
    hidden: contentAdminHidden,
    useAsTitle: 'title',
  },
  fields: [
    { name: 'title', type: 'text', required: true, unique: true },
    { name: 'slug', type: 'text', index: true, required: true, unique: true },
    { name: 'href', type: 'text', required: true, unique: true },
    { name: 'description', type: 'textarea', required: true },
    ...relatedContentJoinFields('relatedTools'),
    {
      name: 'relatedTldPages',
      type: 'join',
      access: {
        read: ({ req }) => hasRole(req.user, ['content_editor', 'system_admin']),
      },
      admin: {
        allowCreate: true,
        defaultColumns: ['title', 'workflowStatus', 'publishedAt', 'updatedAt'],
      },
      collection: 'tldPages',
      defaultLimit: 20,
      maxDepth: 0,
      on: 'relatedTools',
    },
  ],
}

const taxonomyCollection = (slug: 'categories' | 'tags'): CollectionConfig => ({
  slug,
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: taxonomyRead,
    update: contentManagers,
  },
  admin: {
    defaultColumns: ['title', 'slug', 'updatedAt'],
    group: ADMIN_GROUPS.content,
    hidden: contentAdminHidden,
    useAsTitle: 'title',
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', index: true, required: true, unique: true },
    { name: 'description', type: 'textarea' },
  ],
})

export const Categories = taxonomyCollection('categories')
export const Tags = taxonomyCollection('tags')

export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: publicRead,
    update: contentManagers,
  },
  admin: { group: ADMIN_GROUPS.content, hidden: contentAdminHidden, useAsTitle: 'alt' },
  fields: [
    { name: 'alt', type: 'text', required: true },
    { name: 'source', type: 'text' },
    { name: 'reviewed', type: 'checkbox', defaultValue: false, required: true },
  ],
  upload: {
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  },
}

export const Navigation: CollectionConfig = {
  slug: 'navigation',
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: publicRead,
    update: contentManagers,
  },
  admin: { group: ADMIN_GROUPS.content, hidden: contentAdminHidden, useAsTitle: 'label' },
  fields: [
    { name: 'label', type: 'text', required: true },
    { name: 'href', type: 'text', required: true },
    { name: 'order', type: 'number', min: 0, required: true },
    { name: 'enabled', type: 'checkbox', defaultValue: true, required: true },
  ],
}

export const SiteSettings: CollectionConfig = {
  slug: 'siteSettings',
  access: {
    create: systemAdminOnly,
    delete: systemAdminOnly,
    read: publicRead,
    update: systemAdminOnly,
  },
  admin: { group: ADMIN_GROUPS.content, hidden: systemAdminHidden, useAsTitle: 'key' },
  fields: [
    { name: 'key', type: 'text', index: true, required: true, unique: true },
    { name: 'value', type: 'json', required: true },
    { name: 'description', type: 'textarea' },
  ],
}
