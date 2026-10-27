import { Backoff, sleep } from './backoff'
import { LanderError } from './errors'
import { describe, type LanderLogger } from './logger'
import { landerSdkVersion } from '../version'

/** The parts of a `fetch` response the SDK reads. */
export type ResponseLike = {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

/** The parts of `fetch` the SDK uses. Tests pass a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: unknown },
) => Promise<ResponseLike>

export type Json = Record<string, unknown>

/** Thin JSON client for the `/v1/sdk/*` endpoints in docs/API.md. */
export class LanderApi {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetch: FetchLike
  private readonly logger: LanderLogger

  /** Per attempt request timeout in milliseconds. */
  readonly timeout: number

  /** Backoff between attempts of `post` when `maxAttempts > 1`. */
  readonly backoff: Backoff

  /**
   * Total time in milliseconds one `post` may wait between its attempts.
   * Callers of `post` are waiting on the answer (a share button, the first
   * screen), so a longer `Retry-After` ends the retries and the error, with
   * its `retryAfter`, goes to the caller instead.
   */
  readonly maxRetryWait: number

  constructor(options: {
    apiKey: string
    baseUrl: string
    fetch: FetchLike
    logger: LanderLogger
    timeout?: number
    backoff?: Backoff
    maxRetryWait?: number
  }) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl
    this.fetch = options.fetch
    this.logger = options.logger
    this.timeout = options.timeout ?? 10_000
    this.backoff = options.backoff ?? new Backoff({ base: 500, max: 4000 })
    this.maxRetryWait = options.maxRetryWait ?? 10_000
  }

  /**
   * POSTs `body` as JSON and returns the decoded response object.
   *
   * Retries retryable failures (network errors, timeouts, 408, 429, 5xx) up to
   * `maxAttempts` times, reusing the same `idempotencyKey` so the server can
   * drop duplicates, and waiting at most `maxRetryWait` in total. A 2xx
   * response must be a JSON object (except 204). Rejects with `LanderError`.
   */
  async post(
    path: string,
    body: Json,
    options: { idempotencyKey?: string; maxAttempts?: number } = {},
  ): Promise<Json> {
    const maxAttempts = options.maxAttempts ?? 1
    let attempt = 0
    let waited = 0
    for (;;) {
      try {
        return await this.postOnce(path, body, options.idempotencyKey)
      } catch (err) {
        const e = err as LanderError
        attempt++
        if (!e.isRetryable || attempt >= maxAttempts) throw e
        let wait = this.backoff.delay(attempt - 1)
        if (e.retryAfter !== null && e.retryAfter * 1000 > wait) wait = e.retryAfter * 1000
        if (waited + wait > this.maxRetryWait) {
          this.logger.log(
            `POST ${path} failed (${e.code}), not retrying: next try in ${Math.round(wait / 1000)}s`,
          )
          throw e
        }
        waited += wait
        this.logger.log(`POST ${path} failed (${e.code}), retrying in ${wait} ms`)
        await sleep(wait)
      }
    }
  }

  private async postOnce(path: string, body: Json, idempotencyKey?: string): Promise<Json> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Lander-Sdk': `react-native/${landerSdkVersion}`,
    }
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey

    let status: number
    let text: string
    let retryAfterHeader: string | null
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort()
        reject(
          new LanderError({
            code: 'timeout',
            message: `POST ${path} timed out after ${Math.round(this.timeout / 1000)}s`,
          }),
        )
      }, this.timeout)
    })
    try {
      const request = (async () => {
        const res = await this.fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller?.signal,
        })
        return { status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() }
      })()
      // The request may still settle after a timeout; nothing waits for it.
      request.catch(() => {})
      const res = await Promise.race([request, timedOut])
      status = res.status
      text = res.text
      retryAfterHeader = res.retryAfter
    } catch (e) {
      if (e instanceof LanderError) throw e
      throw new LanderError({ code: 'network_error', message: `POST ${path} failed: ${describe(e)}` })
    } finally {
      clearTimeout(timer)
    }

    const json = decode(text)
    if (status >= 200 && status < 300) {
      if (json !== null) return json
      if (status === 204) return {}
      // For example a captive portal or proxy page. Treating it as success
      // would, for init, mark the first launch reported and lose a deferred link.
      throw new LanderError({
        statusCode: status,
        code: 'invalid_response',
        message: `POST ${path} returned ${status} without a JSON object`,
      })
    }
    const error = json?.error
    const errorObj = error !== null && typeof error === 'object' ? (error as Json) : null
    throw new LanderError({
      statusCode: status,
      code: typeof errorObj?.code === 'string' ? errorObj.code : `http_${status}`,
      message: typeof errorObj?.message === 'string' ? errorObj.message : `POST ${path} returned ${status}`,
      retryAfter: parseRetryAfter(retryAfterHeader),
    })
  }
}

function decode(body: string): Json | null {
  if (body === '') return null
  try {
    const decoded: unknown = JSON.parse(body)
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Json)
      : null
  } catch {
    return null
  }
}

/** `Retry-After` in seconds, capped at one hour. HTTP dates are ignored. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null
  const trimmed = header.trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  return Math.min(Math.max(parseInt(trimmed, 10), 0), 3600)
}
