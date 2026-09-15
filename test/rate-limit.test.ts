import { describe, expect, it } from 'vitest'
import { createRateLimiter } from '../src/rate-limit.js'

/** Controllable clock: the limiter is pure apart from `now`. */
function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('rate limiter', () => {
  it('allows a burst up to capacity, then denies with a retry-after', () => {
    const c = clock()
    const limiter = createRateLimiter({ capacity: 3, refillPerMinute: 3, now: c.now })
    expect([1, 2, 3].map(() => limiter.take('ip').allowed)).toEqual([true, true, true])
    const denied = limiter.take('ip')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfter).toBeGreaterThan(0)
  })

  it('refills over time', () => {
    const c = clock()
    const limiter = createRateLimiter({ capacity: 2, refillPerMinute: 60, now: c.now })
    limiter.take('ip')
    limiter.take('ip')
    expect(limiter.take('ip').allowed).toBe(false)
    c.advance(1_000) // 60/min = one token per second
    expect(limiter.take('ip').allowed).toBe(true)
  })

  it('keeps keys independent, so one noisy source cannot spend another one budget', () => {
    const c = clock()
    const limiter = createRateLimiter({ capacity: 1, refillPerMinute: 1, now: c.now })
    expect(limiter.take('noisy').allowed).toBe(true)
    expect(limiter.take('noisy').allowed).toBe(false)
    expect(limiter.take('game-server').allowed).toBe(true)
  })

  it('bounds memory: full buckets are swept and new keys are refused at the cap', () => {
    const c = clock()
    const limiter = createRateLimiter({ capacity: 1, refillPerMinute: 60, maxKeys: 2, now: c.now })
    limiter.take('a')
    limiter.take('b')
    expect(limiter.size()).toBe(2)
    // Both spent their token and have not refilled: a third key is refused, not stored.
    expect(limiter.take('c').allowed).toBe(false)
    expect(limiter.size()).toBe(2)
    // A key already tracked is still served.
    c.advance(1_000)
    expect(limiter.take('a').allowed).toBe(true)
    // Once buckets refill they are swept, making room again.
    c.advance(60_000)
    expect(limiter.take('c').allowed).toBe(true)
    expect(limiter.size()).toBeLessThanOrEqual(2)
  })
})
