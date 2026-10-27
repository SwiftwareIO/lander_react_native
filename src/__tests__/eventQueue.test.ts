import { afterEach, beforeEach, expect, jest, test } from '@jest/globals'
import { Backoff } from '../core/backoff'
import { LanderError } from '../core/errors'
import { EventQueue, type QueuedEvent } from '../core/eventQueue'
import { LanderLogger } from '../core/logger'

function event(id: string): QueuedEvent {
  return { id, type: 'custom', name: 'purchase', properties: {}, occurredAt: '2026-10-15T10:00:00.000Z' }
}

class Harness {
  readonly batches: string[][] = []

  constructor(
    readonly storage = new Map<string, string>(),
    public failWith: ((call: number) => LanderError | null) | null = null,
  ) {}

  queue(options: { batchSize?: number; maxQueueSize?: number } = {}): EventQueue {
    return new EventQueue({
      read: async (k) => this.storage.get(k) ?? null,
      write: async (k, v) => {
        this.storage.set(k, v)
      },
      sender: async (events) => {
        this.batches.push(events.map((e) => e.id))
        const error = this.failWith?.(this.batches.length) ?? null
        if (error !== null) throw error
      },
      logger: new LanderLogger(false),
      batchSize: options.batchSize ?? 100,
      maxQueueSize: options.maxQueueSize ?? 1000,
      flushDelay: 2000,
      backoff: new Backoff({ base: 1000, max: 30_000, jitter: 0 }),
    })
  }

  get persistedIds(): string[] {
    const raw = this.storage.get(EventQueue.storageKey)
    return raw === undefined ? [] : (JSON.parse(raw) as QueuedEvent[]).map((e) => e.id)
  }
}

const serverError = new LanderError({ code: 'internal', message: 'boom', statusCode: 503 })

const tick = (ms = 0) => jest.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

test('batches queued events after the flush delay', async () => {
  const h = new Harness()
  const q = h.queue({ batchSize: 100 })
  for (let i = 0; i < 250; i++) void q.add(event(`e${i}`))
  await tick()
  expect(h.batches).toEqual([])
  expect(h.persistedIds).toHaveLength(250)

  await tick(2000)
  expect(h.batches.map((b) => b.length)).toEqual([100, 100, 50])
  expect(h.batches.flat()).toEqual(Array.from({ length: 250 }, (_, i) => `e${i}`))
  expect(q.pending).toEqual([])
  expect(h.persistedIds).toEqual([])
})

test('deduplicates events by id', async () => {
  const h = new Harness()
  const q = h.queue()
  void q.add(event('a'))
  void q.add(event('a'))
  void q.add(event('b'))
  await tick()
  expect(q.pending.map((e) => e.id)).toEqual(['a', 'b'])
  await tick(2000)
  expect(h.batches).toEqual([['a', 'b']])
})

test('retries with exponential backoff and keeps events until accepted', async () => {
  const h = new Harness(new Map(), (call) => (call <= 3 ? serverError : null))
  const q = h.queue()
  void q.add(event('a'))
  await tick(2000)
  expect(h.batches).toHaveLength(1)
  expect(h.persistedIds).toEqual(['a'])

  await tick(999)
  expect(h.batches).toHaveLength(1)
  await tick(1) // 1 s
  expect(h.batches).toHaveLength(2)
  await tick(2000) // 2 s
  expect(h.batches).toHaveLength(3)

  // A new event during backoff does not cut the backoff short.
  void q.add(event('b'))
  await tick(3000)
  expect(h.batches).toHaveLength(3)
  await tick(1000) // 4 s
  expect(h.batches).toHaveLength(4)
  expect(h.batches.at(-1)).toEqual(['a', 'b'])
  expect(h.batches.every((b) => b[0] === 'a')).toBe(true)
  expect(q.pending).toEqual([])
  expect(h.persistedIds).toEqual([])
})

test('honors Retry-After when it is longer than the backoff', async () => {
  const h = new Harness(new Map(), (call) =>
    call === 1
      ? new LanderError({ code: 'rate_limited', message: '', statusCode: 429, retryAfter: 20 })
      : null,
  )
  void h.queue().add(event('a'))
  await tick(2000)
  await tick(19_000)
  expect(h.batches).toHaveLength(1)
  await tick(1000)
  expect(h.batches).toHaveLength(2)
})

test('drops a batch the API rejects as invalid instead of blocking the queue', async () => {
  const h = new Harness(new Map(), (call) =>
    call === 1 ? new LanderError({ code: 'validation_error', message: '', statusCode: 400 }) : null,
  )
  const q = h.queue({ batchSize: 1 })
  void q.add(event('bad'))
  void q.add(event('good'))
  await tick(2000)
  expect(h.batches).toEqual([['bad'], ['good']])
  expect(q.pending).toEqual([])
})

test('pauses on an auth error and keeps events for the next launch', async () => {
  const h = new Harness(
    new Map(),
    () => new LanderError({ code: 'invalid_api_key', message: '', statusCode: 401 }),
  )
  void h.queue().add(event('a'))
  await tick(10 * 60 * 1000)
  expect(h.batches).toHaveLength(1)
  expect(h.persistedIds).toEqual(['a'])
})

test('persists across restarts and does not resend accepted events', async () => {
  const storage = new Map<string, string>()
  const offline = new Harness(storage, () => serverError)
  const q1 = offline.queue()
  void q1.add(event('a'))
  void q1.add(event('b'))
  await tick(2000)
  q1.dispose()
  expect(offline.persistedIds).toEqual(['a', 'b'])

  // Next launch, back online.
  const online = new Harness(storage)
  const q2 = online.queue()
  void q2.load()
  await tick()
  expect(q2.pending.map((e) => e.id)).toEqual(['a', 'b'])
  void q2.add(event('a')) // already queued: ignored
  void q2.add(event('c'))
  void q2.flush()
  await tick()
  expect(online.batches).toEqual([['a', 'b', 'c']])
  expect(online.persistedIds).toEqual([])
})

test('drops the oldest events beyond maxQueueSize', async () => {
  const h = new Harness(new Map(), () => serverError)
  const q = h.queue({ maxQueueSize: 3 })
  for (const id of ['a', 'b', 'c', 'd', 'e']) void q.add(event(id))
  await tick()
  expect(q.pending.map((e) => e.id)).toEqual(['c', 'd', 'e'])
})

test('concurrent flushes share one request', async () => {
  const h = new Harness()
  const q = h.queue()
  void q.add(event('a'))
  await tick()
  void q.flush()
  void q.flush()
  await tick()
  expect(h.batches).toHaveLength(1)
})

test('survives corrupt persisted data', async () => {
  const h = new Harness(new Map([[EventQueue.storageKey, '{not json']]))
  const q = h.queue()
  void q.add(event('a'))
  await tick()
  expect(q.pending.map((e) => e.id)).toEqual(['a'])
})
