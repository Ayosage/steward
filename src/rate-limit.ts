/**
 * In-process per-key token bucket. Steward runs as a single Fly machine with
 * `min_machines_running = 1` and no autoscaling, so one process sees every
 * webhook request and an external store would be a paid dependency for nothing.
 * If Steward ever runs more than one machine this becomes per-machine, which
 * multiplies the effective limit by the machine count.
 */
export interface RateLimitVerdict {
  allowed: boolean
  /** Seconds until the next token, for `Retry-After`. Always >= 1 when denied. */
  retryAfter: number
}

export interface RateLimiter {
  take(key: string): RateLimitVerdict
  /** Live bucket count, for tests and diagnostics. */
  size(): number
}

export interface RateLimiterOptions {
  /** Burst size: tokens available to an idle key. */
  capacity: number
  /** Sustained rate, tokens added per minute. */
  refillPerMinute: number
  /** Hard cap on tracked keys so a spray of spoofed sources cannot grow the map. */
  maxKeys?: number
  now?: () => number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { capacity, refillPerMinute } = opts
  const maxKeys = opts.maxKeys ?? 10_000
  const now = opts.now ?? Date.now
  const perMs = refillPerMinute / 60_000
  const buckets = new Map<string, Bucket>()

  /** Drop keys that have refilled to full: they are indistinguishable from unseen. */
  const sweep = (t: number): void => {
    for (const [key, b] of buckets) {
      if (b.tokens + (t - b.updatedAt) * perMs >= capacity) buckets.delete(key)
    }
  }

  return {
    take(key) {
      const t = now()
      let bucket = buckets.get(key)
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          sweep(t)
          // Still full: refuse new keys rather than grow. Keys already in the map
          // (the game server, mid-burst) keep being served normally.
          if (buckets.size >= maxKeys) return { allowed: false, retryAfter: 60 }
        }
        bucket = { tokens: capacity, updatedAt: t }
        buckets.set(key, bucket)
      }
      bucket.tokens = Math.min(capacity, bucket.tokens + (t - bucket.updatedAt) * perMs)
      bucket.updatedAt = t
      if (bucket.tokens < 1) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)) }
      }
      bucket.tokens -= 1
      return { allowed: true, retryAfter: 0 }
    },
    size: () => buckets.size,
  }
}
