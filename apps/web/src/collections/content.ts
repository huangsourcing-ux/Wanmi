import type { CollectionConfig, Field } from 'payload'

import {
  contentManagers,
  publishedOrContentManager,
  publicRead,
  systemAdminOnly,
} from '@/access/roles'

const slugFields: Field[] = [
  { name: 'title', type: 'text', required: true },
  { name: 'slug', type: 'text', index: true, required: true, unique: true },
  { name: 'summary', type: 'textarea' },
]

const versionedContent = (slug: 'articles' | 'tldPages' | 'topics'): CollectionConfig => ({
  slug,
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: publishedOrContentManager,
    update: contentManagers,
  },
  admin: { useAsTitle: 'title' },
  fields: [
    ...slugFields,
    { name: 'content', type: 'richText', required: true },
    { name: 'publishedAt', type: 'date', index: true },
    { name: 'source', type: 'text' },
  ],
  versions: {
    drafts: { autosave: true, schedulePublish: true },
    maxPerDoc: 50,
  },
})

export const Articles = versionedContent('articles')
export const Topics = versionedContent('topics')
export const TldPages = versionedContent('tldPages')

export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    create: contentManagers,
    delete: systemAdminOnly,
    read: publicRead,
    update: contentManagers,
  },
  admin: { useAsTitle: 'alt' },
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
  admin: { useAsTitle: 'label' },
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
  admin: { useAsTitle: 'key' },
  fields: [
    { name: 'key', type: 'text', index: true, required: true, unique: true },
    { name: 'value', type: 'json', required: true },
    { name: 'description', type: 'textarea' },
  ],
}
