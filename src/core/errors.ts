/**
 * The error every Lander call rejects with.
 *
 * Calls that need an answer from the API (`createLink`, `claimHandoff`) reject
 * with the API's error code, or a client side one (`network_error`, `timeout`,
 * `invalid_response`, `install_not_registered`). Programming mistakes reject
 * with `invalid_argument` (a bad key, path, name or ID) or `not_initialized`
 * (a call before `Lander.initialize`). Fire and forget calls (`initialize`,
 * `trackEvent`) never reject because of the network.
 */
export class LanderError extends Error {
  /**
   * The API's error code (for example `rate_limited`), or one of the client
   * side codes above. `http_<status>` when the response carried no code.
   */
  readonly code: string

  /** HTTP status, or null when no response was received. */
  readonly statusCode: number | null

  /** Server requested delay before retrying, in seconds, from the `Retry-After` header. */
  readonly retryAfter: number | null

  constructor(options: {
    code: string
    message: string
    statusCode?: number | null
    retryAfter?: number | null
  }) {
    super(options.message)
    this.name = 'LanderError'
    this.code = options.code
    this.statusCode = options.statusCode ?? null
    this.retryAfter = options.retryAfter ?? null
    // Keep instanceof working when the class is transpiled to ES5.
    Object.setPrototypeOf(this, LanderError.prototype)
  }

  /**
   * Whether retrying the same request later may succeed.
   *
   * `link_quota_exceeded` is a 429 but frees up only as the rolling 24 hour
   * window moves, so retrying soon cannot help. `invalid_response` usually
   * comes from something between the app and Lander (a captive portal).
   */
  get isRetryable(): boolean {
    if (this.code === 'link_quota_exceeded') return false
    if (this.code === 'invalid_argument' || this.code === 'not_initialized') return false
    if (this.code === 'invalid_response') return true
    const s = this.statusCode
    return s === null || s === 408 || s === 429 || s >= 500
  }

  override toString(): string {
    return `LanderError(${this.code}${this.statusCode === null ? '' : `, ${this.statusCode}`}): ${this.message}`
  }
}

/** A programming mistake in the arguments of a Lander call. */
export function invalidArgument(message: string): LanderError {
  return new LanderError({ code: 'invalid_argument', message })
}
