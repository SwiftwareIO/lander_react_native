/** Exponential backoff with jitter: `base * 2^attempt`, capped at `max`. All values in milliseconds. */
export class Backoff {
  readonly base: number
  readonly max: number
  /** Fraction of the delay that is randomized, between 0 and 1. */
  readonly jitter: number

  constructor(options: { base?: number; max?: number; jitter?: number } = {}) {
    this.base = options.base ?? 1000
    this.max = options.max ?? 5 * 60 * 1000
    this.jitter = options.jitter ?? 0.2
  }

  /** Delay in milliseconds before retry number `attempt` (0 based). */
  delay(attempt: number, random: () => number = Math.random): number {
    const exp = this.base * 2 ** Math.min(attempt, 20)
    const capped = Math.min(exp, this.max)
    if (this.jitter <= 0) return Math.round(capped)
    // Spread over [capped * (1 - jitter), capped].
    return Math.round(capped * (1 - this.jitter * random()))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
