import { removeRedirectFixture } from './redirect-fixture'
import { removeAdminAuthFixture } from './admin-auth-fixture'
import { removeFirstPartyEventFixture } from './first-party-event-fixture'
import { removeContentCmsFixture } from './content-cms-fixture'
import { removeAdvertisingFixture } from './advertising-fixture'
import { removeFormBuilderFixture } from './form-builder-fixture'
import { removeRealnameDocumentFixture } from './realname-document-fixture'

export default async function globalTeardown() {
  await removeRealnameDocumentFixture()
  await removeFormBuilderFixture()
  await removeAdvertisingFixture()
  await removeFirstPartyEventFixture()
  await removeContentCmsFixture()
  await removeAdminAuthFixture()
  await removeRedirectFixture()
}
