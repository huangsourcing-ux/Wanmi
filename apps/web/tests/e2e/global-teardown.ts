import { removeRedirectFixture } from './redirect-fixture'
import { removeAdminAuthFixture } from './admin-auth-fixture'
import { removeFirstPartyEventFixture } from './first-party-event-fixture'

export default async function globalTeardown() {
  await removeFirstPartyEventFixture()
  await removeAdminAuthFixture()
  await removeRedirectFixture()
}
