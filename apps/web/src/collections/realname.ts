import type { CollectionBeforeValidateHook, CollectionConfig } from 'payload'

import { deny, ownOrSystem, sensitiveFieldRead, systemAdminOnly } from '@/access/roles'
import { REALNAME_STATUSES } from '@/lib/domain'

// `create` access only gates whether a customer may call the endpoint at all; it
// cannot restrict which `customer` id they submit. Without pinning it here, a
// customer could POST a template attributing it to a different customer's id.
const pinCustomerOwner: CollectionBeforeValidateHook = ({ data, operation, req }) => {
  if (!data || operation !== 'create') return data
  if (req.user?.collection === 'customers') data.customer = req.user.id
  return data
}

export const RealnameTemplates: CollectionConfig = {
  slug: 'realnameTemplates',
  access: {
    create: ({ req }) => req.user?.collection === 'customers',
    delete: deny,
    read: ownOrSystem('customer'),
    update: ownOrSystem('customer'),
  },
  admin: { useAsTitle: 'displayName' },
  hooks: { beforeValidate: [pinCustomerOwner] },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'displayName', type: 'text', required: true },
    { name: 'type', type: 'select', options: ['individual', 'organization'], required: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      options: [...REALNAME_STATUSES],
      required: true,
    },
    { name: 'providerTemplateId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'safeFailureReason', type: 'textarea' },
    { name: 'disabledAt', type: 'date' },
    { name: 'cleanupDueAt', type: 'date', index: true },
  ],
}

export const RealnameDocuments: CollectionConfig = {
  slug: 'realnameDocuments',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { hidden: true },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'template',
      type: 'relationship',
      relationTo: 'realnameTemplates',
      index: true,
      required: true,
    },
    {
      name: 'objectKey',
      type: 'text',
      access: { read: sensitiveFieldRead },
      required: true,
      unique: true,
    },
    {
      name: 'encryptedDataKey',
      type: 'text',
      access: { read: sensitiveFieldRead },
      required: true,
    },
    { name: 'contentType', type: 'text', required: true },
    { name: 'sizeBytes', type: 'number', min: 1, required: true },
    { name: 'sha256', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'deletedAt', type: 'date', index: true },
  ],
}
