export interface TokenBucketRateLimiter {
  allow(key: string, now?: number): boolean
}

export function createTokenBucketRateLimiter(limit: number, windowMs: number): TokenBucketRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return {
    allow(key: string, now = Date.now()): boolean {
      const bucket = buckets.get(key)
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      if (bucket.count >= limit) return false
      bucket.count += 1
      return true
    },
  }
}
