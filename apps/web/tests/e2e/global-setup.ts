import { createRedirectFixture } from './redirect-fixture'
import { createAdminAuthFixture } from './admin-auth-fixture'

export default async function globalSetup() {
  await createRedirectFixture()
  await createAdminAuthFixture()
}
