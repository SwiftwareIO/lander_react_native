import { afterEach, describe, expect, test } from '@jest/globals'
import { Backoff, sleep } from '../core/backoff'
import { LinkDispatcher } from '../core/dispatcher'
import { LanderClient } from '../core/client'
import { LanderError } from '../core/errors'
import { EventQueue } from '../core/eventQueue'
import type { LanderLink } from '../core/models'
import { isUuid } from '../core/uuid'
import { landerSdkVersion } from '../version'
import { deferredSpring, FakeApi, FakePlatform, json, Offline, raw, resolvedP123, settle } from './fakes'

const clients: LanderClient[] = []

function client(
  platform: FakePlatform,
  api: FakeApi,
  options: { dispatcher?: LinkDispatcher; flushDelay?: number } = {},
): LanderClient {
  const c = new LanderClient({
    apiKey: 'pk_test_DemoPublishableKey000000000000',
    baseUrl: 'http://localhost:8787',
    dispatcher: options.dispatcher ?? new LinkDispatcher(),
    platform,
    fetch: api.fetch,
    flushDelay: options.flushDelay ?? 0,
    requestBackoff: new Backoff({ base: 1, jitter: 0 }),
    eventBackoff: new Backoff({ base: 1, jitter: 0 }),
  })
  clients.push(c)
  return c
}

async function started(c: LanderClient): Promise<void> {
  await c.start()
  await c.initDone
  await settle()
}

function listen(c: LanderClient): LanderLink[] {
  const got: LanderLink[] = []
  c.dispatcher.subscribe((l) => got.push(l))
  return got
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

const offline = () => {
  throw new Offline()
}

afterEach(() => {
  for (const c of clients) c.dispose()
  clients.length = 0
})

describe('init', () => {
  test('first launch creates and persists a random install ID and reports isFirstLaunch', async () => {
    const platform = new FakePlatform()
    const api = new FakeApi()
    const c = client(platform, api)
    await started(c)

    const id = platform.storage.get(LanderClient.installIdKey)!
    expect(isUuid(id)).toBe(true)
    expect(c.installId).toBe(id)

    const init = api.to('/v1/sdk/init')
    expect(init).toHaveLength(1)
    expect(init[0]!.body).toEqual({
      installId: id,
      platform: 'ios',
      appVersion: '2.4.0',
      sdkVersion: landerSdkVersion,
      osVersion: '18.1',
      isFirstLaunch: true,
    })
    expect(init[0]!.headers['Idempotency-Key']).toBeDefined()
    expect(platform.storage.get(LanderClient.firstLaunchReportedKey)).toBe('1')
    expect(platform.installReferrerCalls).toBe(0)
  })

  test('later launches reuse the install ID and report isFirstLaunch false', async () => {
    const platform = new FakePlatform()
    await started(client(platform, new FakeApi()))
    const id = platform.storage.get(LanderClient.installIdKey)

    const api = new FakeApi()
    await started(client(platform, api))
    const init = api.to('/v1/sdk/init')
    expect(init).toHaveLength(1)
    expect(init[0]!.body.installId).toBe(id)
    expect(init[0]!.body.isFirstLaunch).toBe(false)
  })

  test('a failed first launch report is retried on the next launch with the same key', async () => {
    const platform = new FakePlatform()
    const down = new FakeApi({
      '/v1/sdk/init': () => json({ error: { code: 'internal', message: '' } }, 500),
    })
    await started(client(platform, down))
    expect(down.to('/v1/sdk/init')).toHaveLength(3)
    expect(platform.storage.get(LanderClient.firstLaunchReportedKey)).toBeUndefined()

    const up = new FakeApi()
    await started(client(platform, up))
    const init = up.to('/v1/sdk/init')[0]!
    expect(init.body.isFirstLaunch).toBe(true)
    expect(init.headers['Idempotency-Key']).toBe(down.requests[0]!.headers['Idempotency-Key'])
  })

  test('Android first launch sends the Play Install Referrer, only once', async () => {
    const platform = new FakePlatform({
      platform: 'android',
      installReferrer: 'utm_source=google-play&lander_token=abc',
    })
    const api = new FakeApi()
    await started(client(platform, api))
    expect(api.to('/v1/sdk/init')[0]!.body.installReferrer).toBe(
      'utm_source=google-play&lander_token=abc',
    )

    const api2 = new FakeApi()
    await started(client(platform, api2))
    expect('installReferrer' in api2.to('/v1/sdk/init')[0]!.body).toBe(false)
    expect(platform.installReferrerCalls).toBe(1)
  })

  test('never rejects when the network is down', async () => {
    const api = new FakeApi({ '/v1/sdk/init': offline })
    const c = client(new FakePlatform(), api)
    await expect(started(c)).resolves.toBeUndefined()
    expect(await c.getInitialLink()).toBeNull()
  })

  test('skips the launch report on an unsupported platform', async () => {
    const api = new FakeApi()
    const c = client(new FakePlatform({ platform: 'web' }), api)
    await started(c)
    expect(api.to('/v1/sdk/init')).toHaveLength(0)
    expect(await c.getInitialLink()).toBeNull()
  })

  test('a deferred link from init becomes the initial link', async () => {
    const api = new FakeApi({
      '/v1/sdk/init': (r) =>
        json({
          installId: r.body.installId,
          deferredLink: { ...resolvedP123, isDeferred: true, confidence: 'probabilistic' },
        }),
    })
    const c = client(new FakePlatform({ platform: 'android' }), api)
    await started(c)
    const link = await c.getInitialLink()
    expect(link?.isDeferred).toBe(true)
    expect(link?.path).toBe('/product/123')
    expect(link?.confidence).toBe('probabilistic')
    expect(link?.url).toBe('https://acme.golander.link/p-123')
  })
})

describe('init robustness', () => {
  test('a malformed deferred link is still delivered', async () => {
    const api = new FakeApi({
      '/v1/sdk/init': (r) =>
        json({
          installId: r.body.installId,
          deferredLink: { ...deferredSpring, url: 42, params: 'discount=15', campaign: 7 },
        }),
    })
    const c = client(new FakePlatform({ platform: 'android' }), api)
    await started(c)
    const link = await c.getInitialLink()
    expect(link?.linkId).toBe(deferredSpring.linkId)
    expect(link?.route).toBe('/sale/spring')
    expect(link?.isDeferred).toBe(true)
    expect(link?.params).toEqual({})
  })

  test('a 2xx init that is not JSON does not count as the first launch report', async () => {
    const platform = new FakePlatform()
    const portal = new FakeApi({ '/v1/sdk/init': () => raw('<html>Sign in to Wi-Fi</html>', 200) })
    await started(client(platform, portal))
    expect(platform.storage.get(LanderClient.firstLaunchReportedKey)).toBeUndefined()

    const up = new FakeApi()
    await started(client(platform, up))
    expect(up.to('/v1/sdk/init')[0]!.body.isFirstLaunch).toBe(true)
    expect(platform.storage.get(LanderClient.firstLaunchReportedKey)).toBe('1')
  })

  test('appVersion and osVersion are cut to the 50 characters the API accepts', async () => {
    const api = new FakeApi()
    const long = `1.0.0+${'b'.repeat(60)}`
    await started(client(new FakePlatform({ appVersion: long, osVersion: 'x'.repeat(80) }), api))
    const body = api.to('/v1/sdk/init')[0]!.body
    expect(body.appVersion).toBe(long.slice(0, 50))
    expect(body.osVersion).toBe('x'.repeat(50))
  })

  test('a failed first launch marker write is retried before the deferred link is delivered', async () => {
    const api = new FakeApi({
      '/v1/sdk/init': (r) => json({ installId: r.body.installId, deferredLink: deferredSpring }),
    })
    const platform = new FakePlatform({ platform: 'android' })
    platform.writeFailures.set(LanderClient.firstLaunchReportedKey, 2)
    const c = client(platform, api)
    await started(c)
    expect((await c.getInitialLink())?.linkId).toBe(deferredSpring.linkId)
    expect(platform.storage.get(LanderClient.firstLaunchReportedKey)).toBe('1')

    const api2 = new FakeApi()
    await started(client(platform, api2))
    expect(api2.to('/v1/sdk/init')[0]!.body.isFirstLaunch).toBe(false)
  })

  test('getInitialLink delivers the launch link once', async () => {
    const api = new FakeApi({
      '/v1/sdk/init': (r) => json({ installId: r.body.installId, deferredLink: deferredSpring }),
    })
    const c = client(new FakePlatform({ platform: 'android' }), api)
    await started(c)
    expect((await c.getInitialLink())?.linkId).toBe(deferredSpring.linkId)
    expect(await c.getInitialLink()).toBeNull()
  })
})

describe('registration retry', () => {
  const flakyInit = (up: () => boolean, deferredLink: unknown = null) =>
    new FakeApi({
      '/v1/sdk/init': (r) => (up() ? json({ installId: r.body.installId, deferredLink }) : offline()),
      '/v1/sdk/handoffs/claim': () => json({ deferredLink: null }),
    })

  test('a failed first launch init is retried when the app becomes active, once at a time', async () => {
    let up = false
    const api = flakyInit(() => up, deferredSpring)
    const platform = new FakePlatform({ platform: 'android' })
    const c = client(platform, api)
    const got = listen(c)
    await started(c)
    expect(await c.getInitialLink()).toBeNull()
    const failed = api.to('/v1/sdk/init').length

    up = true
    platform.sendAppState('active')
    platform.sendAppState('active')
    await settle()

    expect(api.to('/v1/sdk/init')).toHaveLength(failed + 1)
    expect(api.to('/v1/sdk/init').at(-1)!.body.isFirstLaunch).toBe(true)
    expect(platform.storage.get(LanderClient.firstLaunchReportedKey)).toBe('1')
    expect(got.map((l) => l.linkId)).toEqual([deferredSpring.linkId])

    platform.sendAppState('active')
    await settle()
    expect(api.to('/v1/sdk/init')).toHaveLength(failed + 1)
  })

  test('claimHandoff retries a failed init before giving up', async () => {
    let up = false
    const api = flakyInit(() => up)
    const c = client(new FakePlatform(), api)
    await started(c)
    const failed = api.to('/v1/sdk/init').length

    up = true
    expect(await c.claimHandoff('user_8f2c')).toBeNull()
    expect(api.to('/v1/sdk/init')).toHaveLength(failed + 1)
    expect(api.to('/v1/sdk/handoffs/claim')).toHaveLength(1)
  })

  test('queued events retry a failed init in the same session', async () => {
    let up = false
    const api = flakyInit(() => up)
    const c = client(new FakePlatform(), api)
    await started(c)
    await c.trackEvent('purchase', {}, null)
    await sleep(20)
    expect(api.to('/v1/sdk/events')).toHaveLength(0)

    up = true
    await sleep(200)
    expect(api.to('/v1/sdk/events')).toHaveLength(1)
    expect(c.events.pending).toEqual([])
  })
})

describe('deferred deep linking', () => {
  const deferredApi = (link: unknown = deferredSpring) =>
    new FakeApi({
      '/v1/sdk/init': (r) =>
        json({ installId: r.body.installId, deferredLink: r.body.isFirstLaunch === true ? link : null }),
    })

  test('an Android referrer token comes back as a deterministic deferred link', async () => {
    const platform = new FakePlatform({
      platform: 'android',
      installReferrer: 'lander_token=AbCdEfGh12345678',
    })
    const api = deferredApi()
    const c = client(platform, api)
    await started(c)
    expect(api.to('/v1/sdk/init')[0]!.body.installReferrer).toBe('lander_token=AbCdEfGh12345678')

    const link = (await c.getInitialLink())!
    expect(link.isDeferred).toBe(true)
    expect(link.confidence).toBe('deterministic')
    expect(link.method).toBe('install_referrer')
    expect(link.route).toBe('/sale/spring')
    expect(link.params).toEqual({ discount: '15' })
    expect(link.url).toBe('https://acme.golander.link/spring-sale')
  })

  test('is delivered exactly once, through onDeepLink when nobody asks getInitialLink', async () => {
    const platform = new FakePlatform({
      platform: 'android',
      installReferrer: 'lander_token=AbCdEfGh12345678',
    })
    const c = client(platform, deferredApi())
    const got = listen(c)
    await started(c)
    expect(got).toHaveLength(1)
    expect(got[0]!.isDeferred).toBe(true)
    expect(await c.getInitialLink()).toBeNull()

    // The next launch is not a first launch: nothing is recovered again.
    const api2 = deferredApi()
    const c2 = client(platform, api2)
    const again = listen(c2)
    await started(c2)
    expect(api2.to('/v1/sdk/init')[0]!.body.isFirstLaunch).toBe(false)
    expect(again).toEqual([])
    expect(await c2.getInitialLink()).toBeNull()
  })

  test('a link that opened the app wins over a deferred link', async () => {
    const api = new FakeApi({
      '/v1/sdk/init': (r) => json({ installId: r.body.installId, deferredLink: deferredSpring }),
      '/v1/sdk/resolve': () => json(resolvedP123),
    })
    const c = client(new FakePlatform({ initialLink: 'https://acme.golander.link/p-123' }), api)
    const got = listen(c)
    await started(c)
    expect(got.map((l) => l.path)).toEqual(['/product/123'])
  })

  test('iOS probabilistic links keep their label', async () => {
    const c = client(
      new FakePlatform(),
      deferredApi({ ...deferredSpring, confidence: 'probabilistic', method: 'probabilistic_match' }),
    )
    await started(c)
    const link = (await c.getInitialLink())!
    expect(link.confidence).toBe('probabilistic')
    expect(link.method).toBe('probabilistic_match')
    expect(link.isDeferred).toBe(true)
  })

  test('no deferred link: getInitialLink resolves null after init', async () => {
    const c = client(new FakePlatform(), new FakeApi())
    await started(c)
    expect(await c.getInitialLink()).toBeNull()
  })

  test('a custom scheme URL carrying lander_link resolves that link', async () => {
    const carried = 'https://acme.golander.link/spring-sale?lander_token=AbCdEfGh12345678'
    const rawUrl = `acmeshop://sale/spring?lander_link=${encodeURIComponent(carried)}`
    const api = new FakeApi({
      '/v1/sdk/resolve': () => json({ ...deferredSpring, method: 'landing_page' }),
    })
    const c = client(new FakePlatform({ initialLink: rawUrl }), api)
    await started(c)
    const link = (await c.getInitialLink())!
    expect(api.to('/v1/sdk/resolve')[0]!.body.url).toBe(carried)
    expect(link.isResolved).toBe(true)
    expect(link.method).toBe('landing_page')
    expect(link.isDeferred).toBe(true)
    expect(link.route).toBe('/sale/spring')
    expect(link.url).toBe(rawUrl)
  })

  test('when that resolve fails, the scheme URL still routes to the right screen', async () => {
    const rawUrl = `acmeshop://sale/spring?lander_link=${encodeURIComponent('https://acme.golander.link/x')}`
    const api = new FakeApi({ '/v1/sdk/resolve': offline })
    const c = client(new FakePlatform({ initialLink: rawUrl }), api)
    await started(c)
    const link = (await c.getInitialLink())!
    expect(link.isResolved).toBe(false)
    expect(link.route.startsWith('/sale/spring?')).toBe(true)
  })
})

describe('claimHandoff', () => {
  const handoff = {
    ...deferredSpring,
    params: { discount: '15', ref: 'email' },
    method: 'authenticated_handoff',
  }

  test('returns the handed off link without sending it to listeners', async () => {
    const api = new FakeApi({ '/v1/sdk/handoffs/claim': () => json({ deferredLink: handoff }) })
    const c = client(new FakePlatform(), api)
    const got = listen(c)
    await started(c)

    const link = (await c.claimHandoff('user_8f2c'))!
    expect(link.isDeferred).toBe(true)
    expect(link.confidence).toBe('deterministic')
    expect(link.method).toBe('authenticated_handoff')
    expect(link.params).toEqual({ discount: '15', ref: 'email' })
    expect(got).toEqual([])
    const req = api.to('/v1/sdk/handoffs/claim')[0]!
    expect(req.body).toEqual({ installId: c.installId, userId: 'user_8f2c' })
    expect(req.headers['Idempotency-Key']).toBeDefined()
  })

  test('returns null when nothing is pending', async () => {
    const api = new FakeApi({ '/v1/sdk/handoffs/claim': () => json({ deferredLink: null }) })
    const c = client(new FakePlatform(), api)
    await started(c)
    expect(await c.claimHandoff('user_8f2c')).toBeNull()
  })

  test('retries with one Idempotency-Key, then rejects', async () => {
    let calls = 0
    const api = new FakeApi({
      '/v1/sdk/handoffs/claim': () =>
        ++calls < 2
          ? json({ error: { code: 'internal_error', message: 'x' } }, 500)
          : json({ deferredLink: handoff }),
    })
    const c = client(new FakePlatform(), api)
    await started(c)
    expect((await c.claimHandoff('u'))!.linkId).toBe(deferredSpring.linkId)
    const keys = new Set(api.to('/v1/sdk/handoffs/claim').map((r) => r.headers['Idempotency-Key']))
    expect(keys.size).toBe(1)

    const down = new FakeApi({
      '/v1/sdk/handoffs/claim': () => json({ error: { code: 'internal_error', message: 'x' } }, 500),
    })
    const c2 = client(new FakePlatform(), down)
    await started(c2)
    await rejection(c2.claimHandoff('u'))
    expect(down.to('/v1/sdk/handoffs/claim')).toHaveLength(3)
  })

  test('a malformed handoff response rejects with invalid_response', async () => {
    for (const deferredLink of [{ linkId: 7 }, 'https://acme.golander.link/spring-sale', {}]) {
      const api = new FakeApi({ '/v1/sdk/handoffs/claim': () => json({ deferredLink }) })
      const c = client(new FakePlatform(), api)
      await started(c)
      expect((await rejection(c.claimHandoff('u'))).code).toBe('invalid_response')
    }
  })

  test('a handoff with a field of the wrong type still returns the link', async () => {
    const api = new FakeApi({
      '/v1/sdk/handoffs/claim': () => json({ deferredLink: { ...handoff, url: 42, channel: 1 } }),
    })
    const c = client(new FakePlatform(), api)
    await started(c)
    const link = await c.claimHandoff('u')
    expect(link?.linkId).toBe(deferredSpring.linkId)
    expect(link?.route).toBe('/sale/spring')
  })

  test('rejects with install_not_registered when init never succeeded', async () => {
    const api = new FakeApi({ '/v1/sdk/init': offline })
    const c = client(new FakePlatform(), api)
    await started(c)
    expect((await rejection(c.claimHandoff('u'))).code).toBe('install_not_registered')
    expect(api.to('/v1/sdk/handoffs/claim')).toHaveLength(0)
  })
})

describe('resolve', () => {
  test('a known link resolves to a LanderLink with its params', async () => {
    const api = new FakeApi({ '/v1/sdk/resolve': () => json(resolvedP123) })
    const c = client(
      new FakePlatform({ initialLink: 'https://acme.golander.link/p-123?utm_source=x' }),
      api,
    )
    await started(c)

    const link = (await c.getInitialLink())!
    expect(link.isResolved).toBe(true)
    expect(link.linkId).toBe(resolvedP123.linkId)
    expect(link.path).toBe('/product/123')
    expect(link.route).toBe('/product/123')
    expect(link.params).toEqual({ productId: '123', utm_source: 'x' })
    expect(link.channel).toBe('share')
    expect(link.campaign).toBeNull()
    expect(link.isDeferred).toBe(false)
    expect(link.confidence).toBe('deterministic')
    expect(link.url).toBe('https://acme.golander.link/p-123?utm_source=x')
    expect(link.shortUrl).toBe('https://acme.golander.link/p-123')

    const resolve = api.to('/v1/sdk/resolve')[0]!
    expect(resolve.body).toEqual({
      installId: c.installId,
      url: 'https://acme.golander.link/p-123?utm_source=x',
    })
    expect(resolve.headers['Idempotency-Key']).toBeDefined()
    expect(api.requests[0]!.path).toBe('/v1/sdk/init')
  })

  test('an unknown link (404) is still delivered with the raw URL', async () => {
    const api = new FakeApi()
    const c = client(new FakePlatform({ initialLink: 'https://acme.example/products/9?ref=mail' }), api)
    await started(c)

    const link = (await c.getInitialLink())!
    expect(link.isResolved).toBe(false)
    expect(link.url).toBe('https://acme.example/products/9?ref=mail')
    expect(link.route).toBe('/products/9?ref=mail')
    expect(link.params).toEqual({})
    expect(api.to('/v1/sdk/resolve')).toHaveLength(1)
  })

  test('a network failure delivers the raw URL instead of losing the link', async () => {
    const api = new FakeApi({ '/v1/sdk/resolve': offline })
    const c = client(new FakePlatform({ initialLink: 'https://acme.golander.link/p-123' }), api)
    await started(c)
    const link = (await c.getInitialLink())!
    expect(link.isResolved).toBe(false)
    expect(link.route).toBe('/p-123')
    expect(api.to('/v1/sdk/resolve')).toHaveLength(2)
  })

  test('custom scheme URLs are delivered without a network call', async () => {
    const api = new FakeApi()
    const c = client(new FakePlatform({ initialLink: 'acmeshop://product/123?ref=qr' }), api)
    await started(c)
    const link = (await c.getInitialLink())!
    expect(link.route).toBe('/product/123?ref=qr')
    expect(api.to('/v1/sdk/resolve')).toHaveLength(0)
  })

  test('warm start links are resolved and delivered in arrival order', async () => {
    const api = new FakeApi({
      '/v1/sdk/resolve': async (r) => {
        const url = r.body.url as string
        // The first link resolves slowly; order must still hold.
        if (url.endsWith('slow')) await sleep(20)
        return json({ ...resolvedP123, path: url.replace('https://acme.golander.link', '') })
      },
    })
    const platform = new FakePlatform()
    const c = client(platform, api)
    await started(c)

    const got = listen(c)
    platform.sendLink('https://acme.golander.link/slow')
    platform.sendLink('https://acme.golander.link/fast')
    await sleep(60)
    expect(got.map((l) => l.path)).toEqual(['/slow', '/fast'])
  })

  test('the same URL reported twice in a row counts once', async () => {
    const api = new FakeApi()
    const platform = new FakePlatform({ initialLink: 'https://acme.golander.link/p-123' })
    const c = client(platform, api)
    await started(c)
    const got = listen(c)
    platform.sendLink('https://acme.golander.link/p-123')
    await settle()
    expect(got).toHaveLength(1)
    expect(api.to('/v1/sdk/resolve')).toHaveLength(1)
  })

  test('a link reported while the launch link is read counts once', async () => {
    const api = new FakeApi()
    const platform = new FakePlatform({ initialLink: 'https://acme.golander.link/p-123' })
    // The OS reports the launch URL as an event too, before getInitialLink answers.
    const original = platform.getInitialLink.bind(platform)
    platform.getInitialLink = async () => {
      platform.sendLink('https://acme.golander.link/p-123')
      platform.sendLink('acmeshop://product/9')
      return original()
    }
    const c = client(platform, api)
    const got = listen(c)
    await started(c)
    await settle()
    expect(got.map((l) => l.url)).toEqual(['https://acme.golander.link/p-123', 'acmeshop://product/9'])
    expect(api.to('/v1/sdk/resolve')).toHaveLength(1)
  })
})

describe('events', () => {
  test('trackEvent queues, persists and sends a batch with client ids', async () => {
    const platform = new FakePlatform()
    const api = new FakeApi()
    const c = client(platform, api)
    await started(c)

    await c.trackEvent('purchase', { amount: 49.99, currency: 'USD' }, resolvedP123.linkId)
    await c.trackEvent('signup', {}, undefined)
    await c.events.flush()

    const batches = api.to('/v1/sdk/events')
    expect(batches.length).toBeGreaterThan(0)
    const sent = batches.flatMap((b) => b.body.events as Record<string, unknown>[])
    expect(sent.map((e) => e.name)).toEqual(['purchase', 'signup'])
    const e = sent[0]!
    expect(e.type).toBe('custom')
    expect(e.properties).toEqual({ amount: 49.99, currency: 'USD' })
    expect(e.linkId).toBe(resolvedP123.linkId)
    expect('linkId' in sent[1]!).toBe(false)
    expect(isUuid(e.id)).toBe(true)
    expect(e.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(batches[0]!.body.installId).toBe(c.installId)
    expect(batches[0]!.headers['Idempotency-Key']).toBeDefined()
    expect(JSON.parse(platform.storage.get(EventQueue.storageKey)!)).toEqual([])
  })

  test('events tracked offline are sent on the next launch', async () => {
    const platform = new FakePlatform()
    const down = new FakeApi({ '/v1/sdk/events': offline })
    const c1 = client(platform, down)
    await started(c1)
    await c1.trackEvent('purchase', { amount: 1 }, null)
    await c1.events.flush()
    c1.dispose()
    expect(c1.events.pending).toHaveLength(1)
    const id = c1.events.pending[0]!.id

    const online = new FakeApi()
    const c2 = client(platform, online)
    await started(c2)
    await c2.events.flush()
    const sent = online.to('/v1/sdk/events').flatMap((b) => b.body.events as { id: string }[])
    expect(sent.map((e) => e.id)).toEqual([id])
  })

  test('retries a failed batch with the same idempotency key', async () => {
    let calls = 0
    const api = new FakeApi({
      '/v1/sdk/events': () =>
        ++calls === 1
          ? json({ error: { code: 'internal', message: '' } }, 503)
          : json({ accepted: 1, duplicates: 0 }, 202),
    })
    const c = client(new FakePlatform(), api)
    await started(c)
    await c.trackEvent('purchase', {}, null)
    await sleep(50)
    const sends = api.to('/v1/sdk/events')
    expect(sends).toHaveLength(2)
    expect(sends[0]!.headers['Idempotency-Key']).toBe(sends[1]!.headers['Idempotency-Key'])
    expect(sends[0]!.body.events).toEqual(sends[1]!.body.events)
    expect(c.events.pending).toEqual([])
  })

  test('rejects invalid names, properties and link IDs', async () => {
    const c = client(new FakePlatform(), new FakeApi())
    await started(c)
    for (const call of [
      () => c.trackEvent('', {}, null),
      () => c.trackEvent('x'.repeat(101), {}, null),
      () => c.trackEvent('ok', { when: new Date(2026, 0, 1) }, null),
      () => c.trackEvent('ok', { f: () => 1 }, null),
      () => c.trackEvent('ok', { n: Number.NaN }, null),
      () => c.trackEvent('ok', {}, 'p-123'),
    ]) {
      expect((await rejection(call())).code).toBe('invalid_argument')
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect((await rejection(c.trackEvent('ok', cyclic, null))).code).toBe('invalid_argument')
    expect(c.events.pending).toEqual([])
  })

  test('flushes events when the app goes to the background', async () => {
    const api = new FakeApi()
    const platform = new FakePlatform()
    const c = client(platform, api, { flushDelay: 60 * 60 * 1000 })
    await started(c)
    await c.trackEvent('purchase', {}, null)
    await settle()
    expect(api.to('/v1/sdk/events')).toHaveLength(0)

    platform.sendAppState('background')
    await settle()
    expect(api.to('/v1/sdk/events')).toHaveLength(1)
  })
})

describe('registration', () => {
  test('install_id_conflict creates a new install ID and reports a first launch', async () => {
    const oldId = '11111111-2222-4333-8444-555555555555'
    const platform = new FakePlatform({
      storage: { [LanderClient.installIdKey]: oldId, [LanderClient.firstLaunchReportedKey]: '1' },
    })
    const api = new FakeApi({
      '/v1/sdk/init': (r) =>
        r.body.installId === oldId
          ? json({ error: { code: 'install_id_conflict', message: 'Taken' } }, 409)
          : json({ installId: r.body.installId, deferredLink: null }),
    })
    const c = client(platform, api)
    await started(c)

    const inits = api.to('/v1/sdk/init')
    expect(inits).toHaveLength(2)
    expect(inits[1]!.body.isFirstLaunch).toBe(true)
    expect(c.installId).not.toBe(oldId)
    expect(isUuid(c.installId)).toBe(true)
    expect(platform.storage.get(LanderClient.installIdKey)).toBe(c.installId)
    expect(platform.storage.get(LanderClient.firstLaunchReportedKey)).toBe('1')
  })

  test('events wait for a successful init instead of being dropped', async () => {
    let initUp = false
    const api = new FakeApi({
      '/v1/sdk/init': (r) =>
        initUp
          ? json({ installId: r.body.installId, deferredLink: null })
          : json({ error: { code: 'internal_error', message: '' } }, 500),
    })
    const platform = new FakePlatform()
    const c1 = client(platform, api)
    await started(c1)
    await c1.trackEvent('purchase', {}, null)
    await sleep(30)
    expect(api.to('/v1/sdk/events')).toHaveLength(0)
    expect(c1.events.pending).toHaveLength(1)
    c1.dispose()

    initUp = true
    const c2 = client(platform, api)
    await started(c2)
    await sleep(30)
    expect(api.to('/v1/sdk/events')).toHaveLength(1)
    expect(c2.events.pending).toEqual([])
  })

  test('install_not_found on events registers the install again and keeps the events', async () => {
    let known = false
    const api = new FakeApi({
      '/v1/sdk/init': (r) => {
        known = r.body.isFirstLaunch === true
        return json({ installId: r.body.installId, deferredLink: null })
      },
      '/v1/sdk/events': () =>
        known
          ? json({ accepted: 1, duplicates: 0 }, 202)
          : json({ error: { code: 'install_not_found', message: '' } }, 404),
    })
    // Looks registered locally, but the API forgot it (database reset).
    const platform = new FakePlatform({ storage: { [LanderClient.firstLaunchReportedKey]: '1' } })
    const c = client(platform, api)
    await started(c)
    await c.trackEvent('purchase', {}, null)
    await sleep(50)

    expect(api.to('/v1/sdk/init').at(-1)!.body.isFirstLaunch).toBe(true)
    expect(api.to('/v1/sdk/events').length).toBeGreaterThanOrEqual(2)
    expect(c.events.pending).toEqual([])
  })
})

describe('createLink', () => {
  test('posts to /v1/sdk/links and parses the link', async () => {
    const api = new FakeApi({
      '/v1/sdk/links': (r) =>
        json(
          {
            id: '0d6f1a7e-1111-4222-8333-944445555666',
            url: 'https://acme.golander.link/x7Kp2Qa',
            domain: 'acme.golander.link',
            slug: 'x7Kp2Qa',
            title: null,
            deepLinkPath: r.body.deepLinkPath,
            params: r.body.params,
            campaign: null,
            channel: 'share',
            tags: [],
            expiresAt: null,
            enabled: true,
            createdAt: '2026-10-15T10:00:00Z',
            updatedAt: '2026-10-15T10:00:00Z',
          },
          201,
        ),
    })
    const c = client(new FakePlatform(), api)
    await started(c)
    const link = await c.createLink({
      deepLinkPath: '/product/123',
      params: { productId: '123' },
      channel: 'share',
    })

    expect(link.url).toBe('https://acme.golander.link/x7Kp2Qa')
    expect(link.path).toBe('/product/123')
    expect(link.params).toEqual({ productId: '123' })
    expect(link.createdAt).toBe('2026-10-15T10:00:00Z')
    const req = api.to('/v1/sdk/links')[0]!
    expect(req.headers['Idempotency-Key']).toBeDefined()
    expect(req.body.installId).toBe(c.installId)
  })

  test('rejects with LanderError on failure after retrying with one key', async () => {
    const api = new FakeApi({
      '/v1/sdk/links': () => json({ error: { code: 'internal', message: 'x' } }, 500),
    })
    const c = client(new FakePlatform(), api)
    await started(c)
    expect((await rejection(c.createLink({ deepLinkPath: '/' }))).statusCode).toBe(500)
    const reqs = api.to('/v1/sdk/links')
    expect(reqs).toHaveLength(3)
    expect(new Set(reqs.map((r) => r.headers['Idempotency-Key'])).size).toBe(1)
  })

  test('a response it cannot use rejects with invalid_response', async () => {
    const api = new FakeApi({ '/v1/sdk/links': () => json({ ok: true }, 201) })
    const c = client(new FakePlatform(), api)
    await started(c)
    expect((await rejection(c.createLink({ deepLinkPath: '/' }))).code).toBe('invalid_response')
  })
})
