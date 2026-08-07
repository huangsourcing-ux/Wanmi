import type { Payload } from 'payload'

import type { PublicForm, PublicFormPurpose } from '@/schemas/forms'
import { managedFormToPublicForm, type ManagedFormDocument } from '@/services/forms/form-contracts'

export async function readManagedPublicForm(
  payload: Payload,
  purpose: PublicFormPurpose,
): Promise<PublicForm | undefined> {
  const result = await payload.find({
    collection: 'forms',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    where: { purpose: { equals: purpose } },
  })
  if (result.totalDocs !== 1 || !result.docs[0]) return undefined
  return managedFormToPublicForm(result.docs[0] as ManagedFormDocument)
}
