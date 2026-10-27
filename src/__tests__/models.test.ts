import { describe, expect, test } from '@jest/globals'
import { LanderError } from '../core/errors'
import { LanderLink, shortLinkFromJson } from '../core/models'
import { parseUrl, queryParameters } from '../core/url'
import { isUuid, sha1, URL_NAMESPACE, uuidv4, uuidv5 } from '../core/uuid'
import { deferredSpring, resolvedP123 } from './fakes'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('LanderLink.fromJson', () => {
  test('reads a well formed ResolvedLink', () => {
    const link = LanderLink.fromJson(resolvedP123)
    expect(link.isResolved).toBe(true)
    expect(link.url).toBe('https://acme.golander.link/p-123')
    expect(link.shortUrl).toBe('https://acme.golander.link/p-123')
    expect(link.params).toEqual({ productId: '123', utm_source: 'x' })
    expect(link.route).toBe('/product/123')
    expect(link.confidence).toBe('deterministic')
    expect(link.method).toBe('universal_link')
  })

  test('keeps the URL that opened the app when given', () => {
    const link = LanderLink.fromJson(resolvedP123, 'https://acme.golander.link/p-123?utm_source=x')
    expect(link.url).toBe('https://acme.golander.link/p-123?utm_source=x')
    expect(link.shortUrl).toBe('https://acme.golander.link/p-123')
  })

  test('treats fields of the wrong type as missing instead of throwing', () => {
    const link = LanderLink.fromJson({
      linkId: resolvedP123.linkId,
      url: 42,
      path: '/product/123',
      params: { ok: '1', n: 2, nested: { a: 1 }, list: [1], gone: null },
      campaign: false,
      channel: ['share'],
      isDeferred: 'yes',
      confidence: 7,
      method: { x: 1 },
    })
    expect(link.linkId).toBe(resolvedP123.linkId)
    expect(link.shortUrl).toBeNull()
    expect(link.url).toBe('')
    expect(link.route).toBe('/product/123')
    expect(link.params).toEqual({ ok: '1', n: 2 })
    expect(link.campaign).toBeNull()
    expect(link.channel).toBeNull()
    expect(link.isDeferred).toBe(false)
    expect(link.confidence).toBe('unattributed')
    expect(link.method).toBeNull()
  })

  test('an unparsable url keeps the rest of the link', () => {
    const link = LanderLink.fromJson({ ...deferredSpring, url: 'https://[not a host' })
    expect(link.url).toBe('')
    expect(link.shortUrl).toBe('https://[not a host')
    expect(link.path).toBe('/sale/spring')
    expect(link.isDeferred).toBe(true)
  })

  test('params that are not an object are ignored', () => {
    expect(LanderLink.fromJson({ ...resolvedP123, params: 'discount=15' }).params).toEqual({})
  })

  test('links are frozen plain objects that survive JSON', () => {
    const link = LanderLink.fromJson(resolvedP123)
    expect(Object.isFrozen(link)).toBe(true)
    expect(Object.isFrozen(link.params)).toBe(true)
    expect(JSON.parse(JSON.stringify(link))).toEqual({ ...link })
    expect(JSON.parse(JSON.stringify(link)).route).toBe('/product/123')
  })
})

describe('route', () => {
  test.each([
    ['https://acme.golander.link/p-123', '/p-123'],
    ['https://acme.golander.link/products/9?ref=mail', '/products/9?ref=mail'],
    ['https://acme.golander.link', '/'],
    ['acmeshop://product/123', '/product/123'],
    ['acmeshop://product/123?color=red', '/product/123?color=red'],
    ['acmeshop://Product/123', '/product/123'],
    ['acmeshop://', '/'],
    ['acmeshop:/product/1', '/product/1'],
    ['not a url', '/'],
  ])('%s routes to %s', (url, route) => {
    expect(LanderLink.unresolved(url).route).toBe(route)
  })

  test('a resolved link routes to its path', () => {
    const link = LanderLink.create({
      url: 'https://acme.golander.link/p-123',
      linkId: '0b8f9a52-6f1c-4d3e-9a43-3f0d2b7c1e55',
      path: '/product/123',
    })
    expect(link.isResolved).toBe(true)
    expect(link.route).toBe('/product/123')
  })
})

describe('url helpers', () => {
  test('parses scheme, host, path and query', () => {
    expect(parseUrl('HTTPS://User@Acme.Golander.Link:443/p-123?a=1#frag')).toEqual({
      scheme: 'https',
      host: 'acme.golander.link',
      path: '/p-123',
      query: 'a=1',
    })
    expect(parseUrl('/relative')).toBeNull()
  })

  test('decodes query parameters', () => {
    expect(
      queryParameters('lander_link=https%3A%2F%2Facme.golander.link%2Fx%3Fa%3D1&q=two+words&q=again&bad=%E0'),
    ).toEqual({ lander_link: 'https://acme.golander.link/x?a=1', q: 'two words' })
  })
})

describe('shortLinkFromJson', () => {
  test('parses a created link', () => {
    const link = shortLinkFromJson({
      id: '0d6f1a7e-1111-4222-8333-944445555666',
      url: 'https://acme.golander.link/x7Kp2Qa',
      domain: 'acme.golander.link',
      slug: 'x7Kp2Qa',
      deepLinkPath: '/product/123',
      params: { productId: '123' },
      tags: ['a', 1],
      createdAt: '2026-10-15T10:00:00Z',
    })
    expect(link.path).toBe('/product/123')
    expect(link.tags).toEqual(['a', '1'])
    expect(link.expiresAt).toBeNull()
    expect(link.createdAt).toBe('2026-10-15T10:00:00Z')
  })

  test('throws without an id or url', () => {
    expect(() => shortLinkFromJson({ url: 'https://x' })).toThrow()
  })
})

describe('uuid', () => {
  test('v4 is a valid random UUID', () => {
    const a = uuidv4()
    expect(isUuid(a)).toBe(true)
    expect(a[14]).toBe('4')
    expect(uuidv4()).not.toBe(a)
  })

  test('v5 matches the RFC 4122 reference (as Python and the Dart uuid package compute it)', () => {
    expect(uuidv5(URL_NAMESPACE, 'lander:install:11111111-2222-4333-8444-555555555555')).toBe(
      'c00e80bb-fc74-51ce-a799-9149eaca987a',
    )
    expect(uuidv5(URL_NAMESPACE, 'https://golander.link/ü☕')).toBe('8da7ea09-3dfd-5be2-9366-090b3c7b6f61')
  })

  test('sha1 matches known digests', () => {
    expect(hex(sha1(new TextEncoder().encode('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(hex(sha1(new TextEncoder().encode('a'.repeat(1000))))).toBe(
      '291e9a6c66994949b57ba5e650361e98fc36b1ba',
    )
  })

  test('isUuid follows the API (RFC 9562 versions and variants)', () => {
    expect(isUuid(resolvedP123.linkId)).toBe(true)
    expect(isUuid('p-123')).toBe(false)
    expect(isUuid('6f1c1f9e-8a2b-0c3d-9e4f-5a6b7c8d9e0f')).toBe(false)
  })
})

describe('LanderError', () => {
  test('isRetryable', () => {
    const e = (code: string, statusCode: number | null = null) => new LanderError({ code, message: '', statusCode })
    expect(e('network_error').isRetryable).toBe(true)
    expect(e('rate_limited', 429).isRetryable).toBe(true)
    expect(e('internal_error', 500).isRetryable).toBe(true)
    expect(e('link_quota_exceeded', 429).isRetryable).toBe(false)
    expect(e('validation_error', 400).isRetryable).toBe(false)
    expect(e('invalid_argument').isRetryable).toBe(false)
    expect(e('not_initialized').isRetryable).toBe(false)
    expect(e('invalid_response', 200).isRetryable).toBe(true)
  })

  test('is an Error with a readable toString', () => {
    const err = new LanderError({ code: 'rate_limited', message: 'Slow down', statusCode: 429, retryAfter: 7 })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(LanderError)
    expect(err.toString()).toBe('LanderError(rate_limited, 429): Slow down')
  })
})
