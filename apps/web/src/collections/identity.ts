import type { CollectionConfig } from 'payload'

import { ADMIN_ROLES } from '@/lib/domain'
import {
  deny,
  ownOrSystem,
  sensitiveFieldRead,
  systemAdminField,
  systemAdminOnly,
} from '@/access/roles'
import { customerSessionStrategy } from '@/services/auth/customer-strategy'
import { verifyAdminTotpBeforeLogin } from '@/services/auth/totp'

export const Admins: CollectionConfig = {
  slug: 'admins',
  access: {
    admin: ({ req }) => Boolean(req.user?.collection === 'admins'),
    create: systemAdminOnly,
    delete: systemAdminOnly,
    read: systemAdminOnly,
    update: systemAdminOnly,
  },
  admin: { useAsTitle: 'email' },
  auth: {
    cookies: { sameSite: 'Lax', secure: true },
    lockTime: 10 * 60 * 1000,
    maxLoginAttempts: 5,
    removeTokenFromResponses: true,
    tokenExpiration: Number(process.env.ADMIN_SESSION_SECONDS ?? 43_200),
    useSessions: true,
  },
  fields: [
    {
      name: 'roles',
      type: 'select',
      hasMany: true,
      options: [...ADMIN_ROLES],
      required: true,
      saveToJWT: true,
    },
    {
      name: 'totpSecretEncrypted',
      type: 'text',
      access: { read: sensitiveFieldRead, update: systemAdminField },
    },
    {
      name: 'recoveryCodeHashes',
      type: 'text',
      hasMany: true,
      access: { read: sensitiveFieldRead, update: systemAdminField },
    },
    { name: 'totpEnabled', type: 'checkbox', defaultValue: false, required: true, saveToJWT: true },
    {
      name: 'totpLastUsedStep',
      type: 'number',
      access: { read: sensitiveFieldRead, update: systemAdminField },
    },
  ],
  hooks: { beforeLogin: [verifyAdminTotpBeforeLogin] },
}

export const Customers: CollectionConfig = {
  slug: 'customers',
  access: {
    admin: () => false,
    create: deny,
    delete: deny,
    read: ownOrSystem('id'),
    update: ownOrSystem('id'),
  },
  auth: {
    disableLocalStrategy: true,
    loginWithUsername: { allowEmailLogin: false, requireEmail: false },
    strategies: [customerSessionStrategy],
    useSessions: false,
  },
  fields: [
    {
      name: 'phone',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
      unique: true,
    },
    { name: 'phoneMasked', type: 'text', required: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      options: ['active', 'disabled', 'deletion_requested'],
      required: true,
    },
  ],
}

export const SmsChallenges: CollectionConfig = {
  slug: 'smsChallenges',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { hidden: true },
  fields: [
    { name: 'challengeId', type: 'text', index: true, required: true, unique: true },
    { name: 'phone', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'phoneHash', type: 'text', index: true, required: true },
    { name: 'codeHash', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'ipHash', type: 'text', index: true, required: true },
    { name: 'deviceHash', type: 'text', index: true, required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'attempts', type: 'number', defaultValue: 0, min: 0, required: true },
    { name: 'consumedAt', type: 'date', index: true },
  ],
}

export const CustomerSessions: CollectionConfig = {
  slug: 'customerSessions',
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
      name: 'tokenHash',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
      unique: true,
    },
    { name: 'deviceHash', type: 'text', index: true, required: true },
    { name: 'ipHash', type: 'text', index: true, required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    { name: 'revokedAt', type: 'date', index: true },
    { name: 'lastSeenAt', type: 'date', required: true },
  ],
}
