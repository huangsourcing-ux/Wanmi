import { createRedirectFixture } from './redirect-fixture'
import { createAdminAuthFixture } from './admin-auth-fixture'
import { createFirstPartyEventFixture } from './first-party-event-fixture'
import { createContentCmsFixture } from './content-cms-fixture'

export default async function globalSetup() {
  await createRedirectFixture()
  await createAdminAuthFixture()
  await createContentCmsFixture()
  await createFirstPartyEventFixture()
}
