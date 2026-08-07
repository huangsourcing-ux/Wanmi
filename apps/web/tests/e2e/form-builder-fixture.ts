import { getFixturePayload } from './redirect-fixture'

export const formSubmissionTracePrefix = 'e2e-d3-form-builder'

async function removeFixtureSubmissions() {
  const payload = await getFixturePayload()
  while (true) {
    const submissions = await payload.find({
      collection: 'form-submissions',
      depth: 0,
      limit: 100,
      overrideAccess: true,
      where: { traceId: { contains: formSubmissionTracePrefix } },
    })
    if (!submissions.docs.length) return
    for (const submission of submissions.docs) {
      await payload.delete({
        collection: 'form-submissions',
        id: submission.id,
        overrideAccess: true,
      })
    }
  }
}

export async function createFormBuilderFixture() {
  await removeFixtureSubmissions()
}

export async function removeFormBuilderFixture() {
  await removeFixtureSubmissions()
}
