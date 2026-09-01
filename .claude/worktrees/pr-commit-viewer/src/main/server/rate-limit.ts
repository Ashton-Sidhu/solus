export interface TokenBucketRateLimiter {
  allow(key: string, now?: number): boolean
}

const DEFAULT_MAX_BUCKETS = 10_000

export function createTokenBucketRateLimiter(
  limit: number,
  windowMs: number,
  maxBuckets = DEFAULT_MAX_BUCKETS,
): TokenBucketRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return {
    allow(key: string, now = Date.now()): boolean {
      const bucket = buckets.get(key)
      if (!bucket || bucket.resetAt <= now) {
        if (!bucket && buckets.size >= maxBuckets) {
          // Map preserves insertion order, so this is a constant-time FIFO
          // eviction. Scanning every attacker-controlled key at saturation
          // turns an unauthenticated limiter into its own CPU denial path.
          const oldest = buckets.keys().next().value
          if (oldest !== undefined) buckets.delete(oldest)
        }
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      if (bucket.count >= limit) return false
      bucket.count += 1
      return true
    },
  }
}
