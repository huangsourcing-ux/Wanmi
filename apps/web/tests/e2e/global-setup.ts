import { createRedirectFixture } from './redirect-fixture'
import { createAdminAuthFixture } from './admin-auth-fixture'
import { createFirstPartyEventFixture } from './first-party-event-fixture'

export default async function globalSetup() {
  await createRedirectFixture()
  await createAdminAuthFixture()
  await createFirstPartyEventFixture()
}
