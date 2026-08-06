export class ReadQueueFullError extends Error {}
export class ReadQueueTimeoutError extends Error {}

type QueueEntry = {
  execute: () => Promise<unknown>
  reject: (error: unknown) => void
  resolve: (value: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

export class TokenBucketReadLimiter {
  private lastRefillAt: number
  private queue: QueueEntry[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private tokens: number

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly queueCapacity: number,
    private readonly queueWaitMs: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst
    this.lastRefillAt = now()
  }

  get queueSize(): number {
    return this.queue.length
  }

  schedule<T>(execute: () => Promise<T>): Promise<T> {
    this.refill()
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return Promise.resolve().then(execute)
    }
    if (this.queue.length >= this.queueCapacity) return Promise.reject(new ReadQueueFullError())

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        execute,
        reject,
        resolve: (value) => resolve(value as T),
        timeout: setTimeout(() => {
          const index = this.queue.indexOf(entry)
          if (index === -1) return
          this.queue.splice(index, 1)
          reject(new ReadQueueTimeoutError())
          if (this.queue.length === 0 && this.timer) {
            clearTimeout(this.timer)
            this.timer = undefined
          } else this.armTimer()
        }, this.queueWaitMs),
      }
      this.queue.push(entry)
      this.armTimer()
    })
  }

  private armTimer(): void {
    if (this.timer || this.queue.length === 0) return
    this.refill()
    const delay = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1_000)
    this.timer = setTimeout(() => this.drain(), delay)
  }

  private drain(): void {
    this.timer = undefined
    this.refill()
    while (this.queue.length > 0 && this.tokens >= 1) {
      const entry = this.queue.shift()
      if (!entry) break
      clearTimeout(entry.timeout)
      this.tokens -= 1
      void Promise.resolve().then(entry.execute).then(entry.resolve, entry.reject)
    }
    this.armTimer()
  }

  private refill(): void {
    const currentTime = this.now()
    const elapsedMs = Math.max(0, currentTime - this.lastRefillAt)
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1_000) * this.ratePerSecond)
    this.lastRefillAt = currentTime
  }
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength) {
    const bytes = Number(declaredLength)
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxBytes)
      throw new RangeError('provider response exceeds configured limit')
  }

  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new RangeError('provider response exceeds configured limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
