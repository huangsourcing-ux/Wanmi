import { removeRedirectFixture } from './redirect-fixture'
import { removeAdminAuthFixture } from './admin-auth-fixture'
import { removeFirstPartyEventFixture } from './first-party-event-fixture'
import { removeContentCmsFixture } from './content-cms-fixture'

export default async function globalTeardown() {
  await removeFirstPartyEventFixture()
  await removeContentCmsFixture()
  await removeAdminAuthFixture()
  await removeRedirectFixture()
}
