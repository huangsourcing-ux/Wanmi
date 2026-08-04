import type { CollectionConfig } from 'payload'

import { adManagers, analysts, publicRead, systemAdminOnly } from '@/access/roles'

export const Advertisers: CollectionConfig = {
  slug: 'advertisers',
  access: { create: adManagers, delete: systemAdminOnly, read: adManagers, update: adManagers },
  admin: { useAsTitle: 'name' },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      options: ['active', 'paused'],
      required: true,
    },
    { name: 'notes', type: 'textarea' },
  ],
}

export const AdCreatives: CollectionConfig = {
  slug: 'adCreatives',
  access: { create: adManagers, delete: systemAdminOnly, read: adManagers, update: adManagers },
  admin: { useAsTitle: 'name' },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'advertiser', type: 'relationship', relationTo: 'advertisers', required: true },
    { name: 'image', type: 'relationship', relationTo: 'media', required: true },
    { name: 'alt', type: 'text', required: true },
    {
      name: 'targetUrl',
      type: 'text',
      required: true,
      validate: (value: null | string | undefined) =>
        typeof value === 'string' && (value.startsWith('/') || value.startsWith('https://'))
          ? true
          : '仅允许站内相对路径或 HTTPS URL',
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      options: ['draft', 'approved', 'disabled'],
      required: true,
    },
  ],
}

export const AdPlacements: CollectionConfig = {
  slug: 'adPlacements',
  access: { create: adManagers, delete: systemAdminOnly, read: publicRead, update: adManagers },
  admin: { useAsTitle: 'code' },
  fields: [
    { name: 'code', type: 'text', index: true, required: true, unique: true },
    { name: 'description', type: 'textarea', required: true },
    { name: 'enabled', type: 'checkbox', defaultValue: true, required: true },
  ],
}

export const AdSchedules: CollectionConfig = {
  slug: 'adSchedules',
  access: { create: adManagers, delete: systemAdminOnly, read: analysts, update: adManagers },
  fields: [
    { name: 'creative', type: 'relationship', relationTo: 'adCreatives', required: true },
    { name: 'placement', type: 'relationship', relationTo: 'adPlacements', required: true },
    { name: 'startsAt', type: 'date', index: true, required: true },
    { name: 'endsAt', type: 'date', index: true, required: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'scheduled',
      options: ['scheduled', 'active', 'ended', 'disabled'],
      required: true,
    },
  ],
}
