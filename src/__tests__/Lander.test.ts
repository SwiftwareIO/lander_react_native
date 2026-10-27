import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { LanderError } from '../core/errors'
import { Lander, LanderTesting } from '../Lander'
import type { LanderLink } from '../core/models'
import { FakeApi, FakePlatform, json, resolvedP123, settle } from './fakes'

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) },
  AppState: { addEventListener: () => ({ remove() {} }) },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
  TurboModuleRegistry: { get: () => null },
}))

const KEY = 'pk_test_DemoPublishableKey000000000000'

async function rejection(p: Promise<unknown>): Promise<LanderError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(LanderError)
    return e as LanderError
  }
  throw new Error('expected a rejection')
}

let api: FakeApi
let platform: FakePlatform

beforeEach(() => {
  api = new FakeApi({
    '/v1/sdk/resolve': () => json(resolvedP123),
    '/v1/sdk/links': (r) =>
      json(
        {
          id: '0d6f1a7e-1111-4222-8333-944445555666',
          url: 'https://acme.golander.link/x7Kp2Qa',
          domain: 'acme.golander.link',
          slug: 'x7Kp2Qa',
          deepLinkPath: r.body.deepLinkPath,
          params: r.body.params,
        },
        201,
      ),
    '/v1/sdk/handoffs/claim': () => json({ deferredLink: null }),
  })
  platform = new FakePlatform()
  LanderTesting.setPlatform(platform)
  LanderTesting.setFetch(api.fetch)
})

afterEach(() => {
  LanderTesting.reset()
})

describe('initialize', () => {
  test('rejects secret keys and malformed keys without echoing them', async () => {
    for (const apiKey of [
      'sk_live_SecretKeyThatMustNeverShip0000',
      'pk_live_short',
      'Bearer pk_live_DemoPublishableKey000000000000',
      'pk_live_Demo PublishableKey000000000000',
      'pk_prod_DemoPublishableKey000000000000',
      '',
    ]) {
      const e = await rejection(Lander.initialize({ apiKey }))
      expect(e.code).toBe('invalid_argument')
      if (apiKey !== '') expect(e.message).not.toContain(apiKey)
    }
    expect(Lander.installId).toBeNull()
    expect(api.requests).toEqual([])
  })

  test('rejects instead of throwing synchronously', () => {
    expect(() => {
      void Lander.initialize({ apiKey: 'sk_live_x' }).catch(() => {})
    }).not.toThrow()
  })

  test('trims the key and starts without waiting for the network', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    api.handlers['/v1/sdk/init'] = async (r) => {
      await gate
      return json({ installId: r.body.installId, deferredLink: null })
    }
    await Lander.initialize({ apiKey: `  ${KEY}\n`, baseUrl: 'http://localhost:8787/' })
    expect(Lander.installId).not.toBeNull()
    release()
    await settle()
    const init = api.to('/v1/sdk/init')[0]!
    expect(init.url).toBe('http://localhost:8787/v1/sdk/init')
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
  })

  test('a second call is ignored and returns the first call', async () => {
    const first = Lander.initialize({ apiKey: KEY })
    const second = Lander.initialize({ apiKey: 'pk_live_AnotherPublishableKey00000000' })
    await Promise.all([first, second])
    await settle()
    expect(api.to('/v1/sdk/init')).toHaveLength(1)
    expect(api.to('/v1/sdk/init')[0]!.headers.Authorization).toBe(`Bearer ${KEY}`)
  })
})

describe('before initialize', () => {
  test('methods that need the client reject with not_initialized', async () => {
    for (const call of [
      () => Lander.getInitialLink(),
      () => Lander.createLink({ path: '/x' }),
      () => Lander.claimHandoff('user'),
      () => Lander.trackEvent('purchase'),
    ]) {
      const e = await rejection(call())
      expect(e.code).toBe('not_initialized')
    }
  })

  test('onDeepLink works before initialize and gets the launch link', async () => {
    platform.initialLink = 'https://acme.golander.link/p-123'
    const got: LanderLink[] = []
    const sub = Lander.onDeepLink((l) => got.push(l))
    await Lander.initialize({ apiKey: KEY })
    await settle()
    expect(got.map((l) => l.route)).toEqual(['/product/123'])
    expect(await Lander.getInitialLink()).toBeNull()
    sub.remove()
  })
})

describe('createLink', () => {
  beforeEach(async () => {
    await Lander.initialize({ apiKey: KEY })
  })

  test('maps options to the API body', async () => {
    const link = await Lander.createLink({
      path: '/product/123',
      params: { productId: '123', qty: 2, gift: true },
      title: 'Shoes',
      channel: 'share',
      tags: [],
      expiresAt: new Date(Date.UTC(2027, 0, 1)),
      webFallbackUrl: 'https://acme.example/p/123',
    })
    expect(link.url).toBe('https://acme.golander.link/x7Kp2Qa')
    const body = api.to('/v1/sdk/links')[0]!.body
    expect(body).toEqual({
      deepLinkPath: '/product/123',
      params: { productId: '123', qty: 2, gift: true },
      title: 'Shoes',
      channel: 'share',
      expiresAt: '2027-01-01T00:00:00.000Z',
      webFallbackUrl: 'https://acme.example/p/123',
      installId: Lander.installId,
    })
  })

  test('defaults to the root path', async () => {
    await Lander.createLink()
    expect(api.to('/v1/sdk/links')[0]!.body.deepLinkPath).toBe('/')
  })

  test('validates path, params and expiresAt before sending', async () => {
    for (const options of [
      { path: 'product/123' },
      { params: { nested: { a: 1 } as unknown as string } },
      { expiresAt: 'not a date' },
    ]) {
      expect((await rejection(Lander.createLink(options))).code).toBe('invalid_argument')
    }
    expect(api.to('/v1/sdk/links')).toEqual([])
  })
})

describe('claimHandoff and trackEvent', () => {
  beforeEach(async () => {
    await Lander.initialize({ apiKey: KEY })
  })

  test('claimHandoff trims and checks the user ID', async () => {
    expect((await rejection(Lander.claimHandoff('   '))).code).toBe('invalid_argument')
    expect((await rejection(Lander.claimHandoff('x'.repeat(257)))).code).toBe('invalid_argument')
    expect(await Lander.claimHandoff('  user_8f2c ')).toBeNull()
    expect(api.to('/v1/sdk/handoffs/claim')[0]!.body.userId).toBe('user_8f2c')
  })

  test('trackEvent takes properties and a linkId option', async () => {
    await Lander.trackEvent('purchase', { amount: 49.99 }, { linkId: resolvedP123.linkId })
    await Lander.trackEvent('signup')
    const pending = LanderTesting.client!.events.pending
    expect(pending.map((e) => e.name)).toEqual(['purchase', 'signup'])
    expect(pending[0]!.linkId).toBe(resolvedP123.linkId)
    expect(pending[1]!.properties).toEqual({})
    expect((await rejection(Lander.trackEvent('x', {}, { linkId: 'p-123' }))).code).toBe(
      'invalid_argument',
    )
  })
})
