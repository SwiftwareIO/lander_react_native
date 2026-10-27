import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { LanderApi, type FetchLike } from '../core/api'
import { Backoff } from '../core/backoff'
import { LanderError } from '../core/errors'
import { LanderLogger } from '../core/logger'
import { landerSdkVersion } from '../version'
import { FakeApi, json, Offline, raw } from './fakes'

function api(fetch: FetchLike, timeout = 10_000): LanderApi {
  return new LanderApi({
    apiKey: 'pk_test_DemoPublishableKey000000000000',
    baseUrl: 'http://localhost:8787/',
    fetch,
    logger: new LanderLogger(false),
    timeout,
    backoff: new Backoff({ base: 100, jitter: 0 }),
  })
}

async function rejection(p: Promise<unknown>): Promise<LanderError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(LanderError)
    return e as LanderError
  }
  throw new Error('expected a rejection')
}

afterEach(() => {
  jest.useRealTimers()
})

test('sends auth, JSON, SDK and idempotency headers to the joined URL', async () => {
  const fake = new FakeApi({ '/v1/sdk/init': () => json({ ok: true }) })
  const res = await api(fake.fetch).post('/v1/sdk/init', { a: 1 }, { idempotencyKey: 'key-1' })

  expect(res).toEqual({ ok: true })
  const r = fake.requests[0]!
  expect(r.url).toBe('http://localhost:8787/v1/sdk/init')
  expect(r.headers.Authorization).toBe('Bearer pk_test_DemoPublishableKey000000000000')
  expect(r.headers['Content-Type']).toBe('application/json')
  expect(r.headers['Idempotency-Key']).toBe('key-1')
  expect(r.headers['X-Lander-Sdk']).toBe(`react-native/${landerSdkVersion}`)
  expect(r.body).toEqual({ a: 1 })
})

test('omits the Idempotency-Key header when none is given', async () => {
  const fake = new FakeApi({ '/x': () => json({}) })
  await api(fake.fetch).post('/x', {})
  expect('Idempotency-Key' in fake.requests[0]!.headers).toBe(false)
})

test('maps API errors to LanderError with Retry-After in seconds', async () => {
  const fake = new FakeApi({
    '/x': () => json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'Retry-After': '7' }),
  })
  const e = await rejection(api(fake.fetch).post('/x', {}))
  expect(e.code).toBe('rate_limited')
  expect(e.message).toBe('Slow down')
  expect(e.statusCode).toBe(429)
  expect(e.retryAfter).toBe(7)
  expect(e.isRetryable).toBe(true)
})

test('a 404 is not retryable and keeps the API error code', async () => {
  const fake = new FakeApi()
  const e = await rejection(api(fake.fetch).post('/v1/sdk/resolve', { url: 'x' }, { maxAttempts: 3 }))
  expect(e.code).toBe('link_not_found')
  expect(e.isRetryable).toBe(false)
  expect(fake.requests).toHaveLength(1)
})

test('an error response without a code becomes http_<status>', async () => {
  const fetch: FetchLike = async () => raw('<html>Bad gateway</html>', 502)
  const e = await rejection(api(fetch).post('/x', {}))
  expect(e.code).toBe('http_502')
  expect(e.statusCode).toBe(502)
})

test('network errors become network_error, never a raw exception', async () => {
  const fetch: FetchLike = async () => {
    throw new Offline()
  }
  const e = await rejection(api(fetch).post('/x', {}))
  expect(e.code).toBe('network_error')
  expect(e.statusCode).toBeNull()
  expect(e.isRetryable).toBe(true)
})

test('times out slow requests', async () => {
  jest.useFakeTimers()
  const fetch: FetchLike = () => new Promise(() => {})
  let error: unknown
  api(fetch, 3000)
    .post('/x', {})
    .catch((e: unknown) => {
      error = e
    })
  await jest.advanceTimersByTimeAsync(2000)
  expect(error).toBeUndefined()
  await jest.advanceTimersByTimeAsync(2000)
  expect((error as LanderError).code).toBe('timeout')
})

test('retries retryable failures with the same idempotency key', async () => {
  jest.useFakeTimers()
  let calls = 0
  const fake = new FakeApi({
    '/x': () =>
      ++calls < 3 ? json({ error: { code: 'internal', message: 'boom' } }, 503) : json({ ok: 1 }),
  })
  let result: unknown
  void api(fake.fetch)
    .post('/x', {}, { idempotencyKey: 'same', maxAttempts: 3 })
    .then((r) => {
      result = r
    })
  await jest.advanceTimersByTimeAsync(0)
  expect(fake.requests).toHaveLength(1)
  await jest.advanceTimersByTimeAsync(100) // backoff 0
  expect(fake.requests).toHaveLength(2)
  await jest.advanceTimersByTimeAsync(200) // backoff 1
  expect(result).toEqual({ ok: 1 })
  expect(fake.requests.map((r) => r.headers['Idempotency-Key'])).toEqual(['same', 'same', 'same'])
})

test('decodes non ASCII JSON', async () => {
  const fetch: FetchLike = async () => json({ title: 'Café ☕ für Ümit' })
  expect(await api(fetch).post('/x', {})).toEqual({ title: 'Café ☕ für Ümit' })
})

test('a 2xx response that is not a JSON object is an invalid_response', async () => {
  for (const body of ['<html>Sign in to Wi-Fi</html>', '', '[1, 2]']) {
    const fetch: FetchLike = async () => raw(body, 200)
    const e = await rejection(api(fetch).post('/x', {}))
    expect(e.code).toBe('invalid_response')
    expect(e.statusCode).toBe(200)
    expect(e.isRetryable).toBe(true)
  }
})

test('a 204 without a body is a success', async () => {
  const fetch: FetchLike = async () => raw('', 204)
  expect(await api(fetch).post('/x', {})).toEqual({})
})

test('does not wait for a Retry-After longer than maxRetryWait', async () => {
  const fake = new FakeApi({
    '/x': () =>
      json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'retry-after': '3600' }),
  })
  const started = Date.now()
  const e = await rejection(api(fake.fetch).post('/x', {}, { maxAttempts: 3 }))
  expect(e.retryAfter).toBe(3600)
  expect(fake.requests).toHaveLength(1)
  expect(Date.now() - started).toBeLessThan(1000)
})

test('Retry-After is capped at one hour and HTTP dates are ignored', async () => {
  for (const [header, expected] of [
    ['99999', 3600],
    ['Wed, 21 Oct 2026 07:28:00 GMT', null],
  ] as const) {
    const fetch: FetchLike = async () =>
      json({ error: { code: 'rate_limited', message: '' } }, 429, { 'retry-after': header })
    expect((await rejection(api(fetch).post('/x', {}))).retryAfter).toBe(expected)
  }
})

test('honors a short Retry-After within maxRetryWait', async () => {
  jest.useFakeTimers()
  let calls = 0
  const fake = new FakeApi({
    '/x': () =>
      ++calls < 2
        ? json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'retry-after': '3' })
        : json({ ok: 1 }),
  })
  let result: unknown
  void api(fake.fetch)
    .post('/x', {}, { maxAttempts: 3 })
    .then((r) => {
      result = r
    })
  await jest.advanceTimersByTimeAsync(2900)
  expect(fake.requests).toHaveLength(1)
  await jest.advanceTimersByTimeAsync(200)
  expect(result).toEqual({ ok: 1 })
})

test('stops retrying once the total wait would pass maxRetryWait', async () => {
  jest.useFakeTimers()
  const fake = new FakeApi({
    '/x': () =>
      json({ error: { code: 'rate_limited', message: 'Slow down' } }, 429, { 'retry-after': '6' }),
  })
  let error: unknown
  api(fake.fetch)
    .post('/x', {}, { maxAttempts: 5 })
    .catch((e: unknown) => {
      error = e
    })
  await jest.advanceTimersByTimeAsync(7000)
  // 6 s waited, another 6 s would make 12 s, over the 10 s default.
  expect(fake.requests).toHaveLength(2)
  expect(error).toBeInstanceOf(LanderError)
})

test('link_quota_exceeded is not retried', async () => {
  const fake = new FakeApi({
    '/x': () =>
      json(
        { error: { code: 'link_quota_exceeded', message: 'Daily link quota reached' } },
        429,
        { 'retry-after': '2' },
      ),
  })
  const e = await rejection(api(fake.fetch).post('/x', {}, { maxAttempts: 3 }))
  expect(e.code).toBe('link_quota_exceeded')
  expect(e.isRetryable).toBe(false)
  expect(fake.requests).toHaveLength(1)
})

describe('Backoff', () => {
  test('doubles and caps', () => {
    const b = new Backoff({ base: 1000, max: 10_000, jitter: 0 })
    expect([0, 1, 2, 3, 4, 5].map((i) => b.delay(i))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000])
  })

  test('jitter stays within bounds', () => {
    const b = new Backoff({ base: 10_000, jitter: 0.5 })
    for (let i = 0; i < 50; i++) {
      const d = b.delay(0)
      expect(d).toBeGreaterThanOrEqual(5000)
      expect(d).toBeLessThanOrEqual(10_000)
    }
  })
})
