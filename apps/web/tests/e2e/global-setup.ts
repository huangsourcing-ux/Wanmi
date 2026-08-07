import { createRedirectFixture } from './redirect-fixture'
import { createAdminAuthFixture } from './admin-auth-fixture'
import { createFirstPartyEventFixture } from './first-party-event-fixture'
import { createContentCmsFixture } from './content-cms-fixture'
import { createAdvertisingFixture } from './advertising-fixture'
import { createFormBuilderFixture } from './form-builder-fixture'
import { createRealnameDocumentFixture } from './realname-document-fixture'

export default async function globalSetup() {
  await createRedirectFixture()
  await createAdminAuthFixture()
  await createContentCmsFixture()
  await createFirstPartyEventFixture()
  await createAdvertisingFixture()
  await createFormBuilderFixture()
  await createRealnameDocumentFixture()
}
