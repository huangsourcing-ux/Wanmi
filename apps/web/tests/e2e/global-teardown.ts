import { removeRedirectFixture } from './redirect-fixture'
import { removeAdminAuthFixture } from './admin-auth-fixture'

export default async function globalTeardown() {
  await removeAdminAuthFixture()
  await removeRedirectFixture()
}
