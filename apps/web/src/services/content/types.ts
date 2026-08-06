export const CONTENT_COLLECTIONS = ['articles', 'topics', 'tldPages', 'helpPages'] as const
export type ContentCollection = (typeof CONTENT_COLLECTIONS)[number]

export const CONTENT_WORKFLOW_STATUSES = [
  'draft',
  'in_review',
  'published',
  'unpublished',
  'archived',
] as const
export type ContentWorkflowStatus = (typeof CONTENT_WORKFLOW_STATUSES)[number]

export const CONTENT_WORKFLOW_ACTIONS = [
  'submit_review',
  'publish',
  'schedule_publish',
  'cancel_scheduled_publish',
  'publish_revision',
  'unpublish',
  'archive',
] as const
export type ContentWorkflowAction = (typeof CONTENT_WORKFLOW_ACTIONS)[number]

export const CONTENT_WORKFLOW_CONTEXT = 'contentWorkflowOperation'
export const PUBLIC_TAXONOMY_CONTEXT = 'publicTaxonomyForPublishedArticle'

export function isContentCollection(value: unknown): value is ContentCollection {
  return CONTENT_COLLECTIONS.includes(value as ContentCollection)
}

export function isContentWorkflowStatus(value: unknown): value is ContentWorkflowStatus {
  return CONTENT_WORKFLOW_STATUSES.includes(value as ContentWorkflowStatus)
}

export function contentPublicPath(collection: ContentCollection, slug: string): string {
  const encoded = encodeURIComponent(slug)
  if (collection === 'articles') return `/articles/${encoded}`
  if (collection === 'topics') return `/topics/${encoded}`
  if (collection === 'tldPages') return `/tld/${encoded}`
  return `/help/${encoded}`
}
