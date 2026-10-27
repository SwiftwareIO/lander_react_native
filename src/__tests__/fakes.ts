import type { FetchLike, ResponseLike } from '../core/api'
import type { LanderPlatform, LanderPlatformInfo, Unsubscribe } from '../core/platform'

/** In memory stand in for the native side. */
export class FakePlatform implements LanderPlatform {
  initialLink: string | null
  readonly platform: string
  readonly installReferrer: string | null
  readonly appVersion: string
  readonly osVersion: string
  readonly storage: Map<string, string>
  installReferrerCalls = 0
  /** Number of upcoming writes to each key that fail. */
  readonly writeFailures = new Map<string, number>()
  private readonly linkListeners = new Set<(url: string) => void>()
  private readonly stateListeners = new Set<(state: string) => void>()

  constructor(
    options: {
      initialLink?: string | null
      platform?: string
      installReferrer?: string | null
      appVersion?: string
      osVersion?: string
      storage?: Record<string, string> | Map<string, string>
    } = {},
  ) {
    this.initialLink = options.initialLink ?? null
    this.platform = options.platform ?? 'ios'
    this.installReferrer = options.installReferrer ?? null
    this.appVersion = options.appVersion ?? '2.4.0'
    this.osVersion = options.osVersion ?? '18.1'
    this.storage =
      options.storage instanceof Map ? options.storage : new Map(Object.entries(options.storage ?? {}))
  }

  /** Sends a warm start link, as the OS would. */
  sendLink(url: string): void {
    for (const l of this.linkListeners) l(url)
  }

  /** Sends an AppState change. */
  sendAppState(state: string): void {
    for (const l of this.stateListeners) l(state)
  }

  async getInitialLink(): Promise<string | null> {
    const link = this.initialLink
    this.initialLink = null
    return link
  }

  addLinkListener(listener: (url: string) => void): Unsubscribe {
    this.linkListeners.add(listener)
    return { remove: () => this.linkListeners.delete(listener) }
  }

  addAppStateListener(listener: (state: string) => void): Unsubscribe {
    this.stateListeners.add(listener)
    return { remove: () => this.stateListeners.delete(listener) }
  }

  async getPlatformInfo(): Promise<LanderPlatformInfo> {
    return { platform: this.platform, appVersion: this.appVersion, osVersion: this.osVersion }
  }

  async getInstallReferrer(): Promise<string | null> {
    this.installReferrerCalls++
    return this.installReferrer
  }

  async read(key: string): Promise<string | null> {
    return this.storage.get(key) ?? null
  }

  async write(key: string, value: string): Promise<void> {
    const failures = this.writeFailures.get(key) ?? 0
    if (failures > 0) {
      this.writeFailures.set(key, failures - 1)
      throw new Error('disk full')
    }
    this.storage.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key)
  }
}

/** A recorded request with its decoded JSON body. */
export type Recorded = {
  url: string
  path: string
  headers: Record<string, string>
  body: Record<string, any>
}

export type Handler = (request: Recorded) => ResponseLike | Promise<ResponseLike>

/** Builds a JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): ResponseLike {
  return raw(JSON.stringify(body), status, { 'content-type': 'application/json', ...headers })
}

/** Builds a response with a raw text body. */
export function raw(text: string, status = 200, headers: Record<string, string> = {}): ResponseLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
  }
}

/** Thrown by a handler to simulate a network failure. */
export class Offline extends Error {
  constructor() {
    super('Network request failed')
  }
}

const defaultHandlers: Record<string, Handler> = {
  '/v1/sdk/init': (r) => json({ installId: r.body.installId, deferredLink: null }),
  '/v1/sdk/resolve': () => json({ error: { code: 'link_not_found', message: 'Not found' } }, 404),
  '/v1/sdk/events': (r) => json({ accepted: r.body.events.length, duplicates: 0 }, 202),
}

/** A fake `fetch` that records requests and answers per path. */
export class FakeApi {
  readonly handlers: Record<string, Handler>
  readonly requests: Recorded[] = []

  constructor(handlers: Record<string, Handler> = {}) {
    this.handlers = { ...defaultHandlers, ...handlers }
  }

  to(path: string): Recorded[] {
    return this.requests.filter((r) => r.path === path)
  }

  readonly fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const recorded: Recorded = { url, path, headers: init.headers, body: JSON.parse(init.body) }
    this.requests.push(recorded)
    const handler = this.handlers[path]
    if (!handler) return json({ error: { code: 'not_found', message: 'no route' } }, 404)
    return handler(recorded)
  }
}

export const resolvedP123 = {
  linkId: '6f1c1f9e-8a2b-4c3d-9e4f-5a6b7c8d9e0f',
  url: 'https://acme.golander.link/p-123',
  path: '/product/123',
  params: { productId: '123', utm_source: 'x' },
  campaign: null,
  channel: 'share',
  isDeferred: false,
  confidence: 'deterministic',
  method: 'universal_link',
}

/** What `/v1/sdk/init` returns on an Android first launch with a Play referrer token. */
export const deferredSpring = {
  linkId: '9b1f3c2e-4d5a-4b6c-8d7e-0f1a2b3c4d5e',
  url: 'https://acme.golander.link/spring-sale',
  path: '/sale/spring',
  params: { discount: '15' },
  campaign: 'spring_2027',
  channel: null,
  isDeferred: true,
  confidence: 'deterministic',
  method: 'install_referrer',
}

/** Lets pending promises and zero delay timers run. */
export async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, ms))
}
