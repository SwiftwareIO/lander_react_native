import { expect, test } from '@jest/globals'
import { LinkDispatcher } from '../core/dispatcher'
import { LanderLink } from '../core/models'
import { settle } from './fakes'

const link = (path: string) => LanderLink.unresolved(`https://acme.golander.link${path}`)
const pathOf = (l: LanderLink) => l.route

test('buffers links until the first listener, then replays them in order', async () => {
  const d = new LinkDispatcher()
  d.add(link('/a'))
  d.add(link('/b'))

  const got: string[] = []
  d.subscribe((l) => got.push(pathOf(l)))
  expect(got).toEqual([]) // never delivered during subscribe
  d.add(link('/c'))
  await settle()
  expect(got).toEqual(['/a', '/b', '/c'])
})

test('buffers again while nobody listens', async () => {
  const d = new LinkDispatcher()
  const first: string[] = []
  const sub = d.subscribe((l) => first.push(pathOf(l)))
  d.add(link('/a'))
  await settle()
  sub.remove()

  d.add(link('/b'))
  const second: string[] = []
  d.subscribe((l) => second.push(pathOf(l)))
  await settle()
  expect(first).toEqual(['/a'])
  expect(second).toEqual(['/b'])
})

test('a listener removed before the replay gets nothing (React StrictMode remount)', async () => {
  const d = new LinkDispatcher()
  d.add(link('/a'))
  const first: string[] = []
  d.subscribe((l) => first.push(pathOf(l))).remove()
  const second: string[] = []
  d.subscribe((l) => second.push(pathOf(l)))
  await settle()
  expect(first).toEqual([])
  expect(second).toEqual(['/a'])
})

test('launch link goes to the listeners when getInitialLink is never called', async () => {
  const d = new LinkDispatcher()
  d.setInitialLink(link('/launch'))
  const got: string[] = []
  d.subscribe((l) => got.push(pathOf(l)))
  await settle()
  expect(got).toEqual(['/launch'])
  expect(await d.takeInitialLink()).toBeNull()
})

test('getInitialLink claims the launch link so listeners skip it', async () => {
  const d = new LinkDispatcher()
  const got: string[] = []
  const initial = d.takeInitialLink()
  d.subscribe((l) => got.push(pathOf(l)))
  d.setInitialLink(link('/launch'))
  d.add(link('/later'))
  expect((await initial)?.route).toBe('/launch')
  await settle()
  expect(got).toEqual(['/later'])
})

test('getInitialLink removes a buffered launch link', async () => {
  const d = new LinkDispatcher()
  d.setInitialLink(link('/launch'))
  d.add(link('/later'))
  expect((await d.takeInitialLink())?.route).toBe('/launch')
  expect(await d.takeInitialLink()).toBeNull()

  const got: string[] = []
  d.subscribe((l) => got.push(pathOf(l)))
  await settle()
  expect(got).toEqual(['/later'])
})

test('concurrent getInitialLink calls get the launch link once', async () => {
  const d = new LinkDispatcher()
  const first = d.takeInitialLink()
  const second = d.takeInitialLink()
  d.setInitialLink(link('/launch'))
  const results = await Promise.all([first, second])
  expect(results.filter((l) => l !== null).map((l) => l!.route)).toEqual(['/launch'])
  expect(await d.takeInitialLink()).toBeNull()
})

test('getInitialLink waits until the launch link is known', async () => {
  const d = new LinkDispatcher()
  let done = false
  let result: LanderLink | null = link('/x')
  void d.takeInitialLink().then((l) => {
    result = l
    done = true
  })
  await settle()
  expect(done).toBe(false)
  d.setInitialLink(null)
  await settle()
  expect(done).toBe(true)
  expect(result).toBeNull()
})

test('a second setInitialLink is delivered as a normal link', async () => {
  const d = new LinkDispatcher()
  d.setInitialLink(null)
  d.setInitialLink(link('/deferred'))
  const got: string[] = []
  d.subscribe((l) => got.push(pathOf(l)))
  await settle()
  expect(got).toEqual(['/deferred'])
})

test('multiple listeners all receive live links', async () => {
  const d = new LinkDispatcher()
  const a: string[] = []
  const b: string[] = []
  d.subscribe((l) => a.push(pathOf(l)))
  d.subscribe((l) => b.push(pathOf(l)))
  d.add(link('/x'))
  await settle()
  expect(a).toEqual(['/x'])
  expect(b).toEqual(['/x'])
})

test('a throwing listener does not stop delivery to the others', async () => {
  const d = new LinkDispatcher()
  const got: string[] = []
  const errors: unknown[] = []
  const realSetTimeout = global.setTimeout
  // Capture the rethrown error instead of crashing the test runner.
  ;(global as any).setTimeout = (fn: () => void, ms?: number) =>
    realSetTimeout(() => {
      try {
        fn()
      } catch (e) {
        errors.push(e)
      }
    }, ms)
  try {
    d.subscribe(() => {
      throw new Error('app bug')
    })
    d.subscribe((l) => got.push(pathOf(l)))
    d.add(link('/x'))
    await new Promise((r) => realSetTimeout(r, 5))
  } finally {
    global.setTimeout = realSetTimeout
  }
  expect(got).toEqual(['/x'])
  expect(errors).toHaveLength(1)
})
