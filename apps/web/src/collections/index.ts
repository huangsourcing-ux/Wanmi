import type { CollectionConfig } from 'payload'

import { AdCreatives, AdPlacements, AdSchedules, Advertisers } from './advertising'
import {
  OrderEvents,
  Orders,
  PaymentNotifications,
  PriceRules,
  PriceSnapshots,
  Quotes,
  Refunds,
} from './commerce'
import { Articles, Media, Navigation, SiteSettings, TldPages, Topics } from './content'
import { DomainAssets, NameserverChanges, ProviderOperations, Renewals } from './fulfillment'
import {
  AdminInvitations,
  AdminMfaCredentials,
  Admins,
  Customers,
  CustomerSessions,
  SmsChallenges,
} from './identity'
import {
  AuditLogs,
  CustomerSecurityEvents,
  FirstPartyEvents,
  ManualReviews,
  Reconciliations,
  ToolObservabilityBuckets,
  UserFeedback,
} from './operations'
import { RealnameDocuments, RealnameTemplates } from './realname'

export const collections: CollectionConfig[] = [
  Admins,
  AdminMfaCredentials,
  AdminInvitations,
  Customers,
  SmsChallenges,
  CustomerSessions,
  Articles,
  Topics,
  TldPages,
  Media,
  Navigation,
  SiteSettings,
  Advertisers,
  AdCreatives,
  AdPlacements,
  AdSchedules,
  RealnameTemplates,
  RealnameDocuments,
  PriceRules,
  Quotes,
  Orders,
  OrderEvents,
  PaymentNotifications,
  Refunds,
  ProviderOperations,
  DomainAssets,
  Renewals,
  NameserverChanges,
  ManualReviews,
  Reconciliations,
  AuditLogs,
  FirstPartyEvents,
  ToolObservabilityBuckets,
  UserFeedback,
  CustomerSecurityEvents,
  PriceSnapshots,
]
