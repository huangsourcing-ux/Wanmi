export async function ignorePayloadNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    ) {
      return
    }
    throw error
  }
}
