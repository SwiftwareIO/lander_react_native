import type { FetchLike, Json } from './core/api'
import { LanderClient } from './core/client'
import { LinkDispatcher, type LanderLinkListener, type LanderSubscription } from './core/dispatcher'
import { invalidArgument, LanderError } from './core/errors'
import type { LanderLink, LanderParamValue, LanderShortLink } from './core/models'
import type { LanderPlatform } from './core/platform'
import { createNativePlatform } from './nativePlatform'

/** Options for `Lander.initialize`. */
export type LanderOptions = {
  /** A publishable key: `pk_test_...` or `pk_live_...`. Decides the project and environment. */
  apiKey: string
  /** The Lander API. Only change it to point at a local API. A trailing slash is ignored. */
  baseUrl?: string
  /** Prints `[Lander]` diagnostics with `console.log`. Never logs the API key. */
  enableLogging?: boolean
}

/** Options for `Lander.createLink`. Only `path` is commonly needed. */
export type CreateLinkOptions = {
  /** The in app route the link opens. Must start with `/`. Defaults to `/`. */
  path?: string
  /** Data delivered with the link. Values must be strings, numbers or booleans. */
  params?: Record<string, LanderParamValue>
  title?: string
  campaign?: string
  channel?: string
  tags?: string[]
  iosFallbackUrl?: string
  androidFallbackUrl?: string
  webFallbackUrl?: string
  ogTitle?: string
  ogDescription?: string
  ogImageUrl?: string
  /** After this moment the link stops working. A `Date` or an ISO 8601 string; sent as UTC. */
  expiresAt?: Date | string
}

/** Options for `Lander.trackEvent`. */
export type TrackEventOptions = {
  /** `LanderLink.linkId` of the link to attribute the event to. Must be a UUID. */
  linkId?: string | null
}

/** The format of a publishable key, as in `packages/shared/src/keys.ts`. */
const PUBLISHABLE_KEY = /^pk_(test|live)_[A-Za-z0-9]{24,}$/

const DEFAULT_BASE_URL = 'https://api.golander.link'

let dispatcher = new LinkDispatcher()
let client: LanderClient | null = null
let started: Promise<void> | null = null
let testPlatform: LanderPlatform | null = null
let testFetch: FetchLike | null = null

function requireClient(method: string): LanderClient {
  if (client === null) {
    throw new LanderError({
      code: 'not_initialized',
      message: `Call Lander.initialize() before Lander.${method}()`,
    })
  }
  return client
}

function defaultFetch(): FetchLike {
  return (url, init) => fetch(url, init as RequestInit)
}

/**
 * Entry point of the Lander SDK.
 *
 * Every method that returns a Promise reports its errors through that Promise
 * (as a `LanderError`), never by throwing synchronously.
 *
 * ```ts
 * Lander.initialize({ apiKey: 'pk_live_...' })
 * Lander.onDeepLink((link) => navigate(link.route))
 * ```
 */
export const Lander = {
  /**
   * Starts the SDK. Call it once, as early as possible (in your entry file,
   * before the first render, is fine).
   *
   * Loads or creates the random install ID, starts listening for links and
   * then reports the launch with `POST /v1/sdk/init` in the background, so
   * awaiting this never waits on the network. On an Android first launch the
   * Play Install Referrer is read and sent along. Network failures are logged
   * (when `enableLogging` is on) and never rejected.
   *
   * Rejects with `invalid_argument` when `apiKey` (trimmed) is a secret key or
   * not a publishable key. The key is never included in the error.
   */
  async initialize(options: LanderOptions): Promise<void> {
    if (client !== null) {
      if (options?.enableLogging) console.log('[Lander] initialize called twice; ignoring the second call')
      return started!
    }
    const key = typeof options?.apiKey === 'string' ? options.apiKey.trim() : ''
    if (key.includes('sk_')) {
      throw invalidArgument('apiKey: secret keys must never ship in an app; use a pk_ key')
    }
    if (!PUBLISHABLE_KEY.test(key)) {
      throw invalidArgument(
        'apiKey: expected a publishable key such as pk_live_..., with no "Bearer" prefix or spaces',
      )
    }
    const c = new LanderClient({
      apiKey: key,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      dispatcher,
      platform: testPlatform ?? createNativePlatform(),
      fetch: testFetch ?? defaultFetch(),
      enableLogging: options.enableLogging ?? false,
    })
    client = c
    return (started = c.start())
  },

  /**
   * Calls `listener` with every deep link the app receives: Universal Links,
   * App Links, custom scheme URLs and deferred links (recovered on first
   * launch, with `isDeferred` true and their `confidence`).
   *
   * Safe to call at any time, even before `initialize`. Links that arrive
   * while nobody listens are buffered and replayed in order to the next
   * listener, so nothing is lost while the app (or its navigator) starts. The
   * launch link is included unless `getInitialLink` claimed it first.
   *
   * Unknown links (not created in Lander) and links that could not be
   * resolved because of the network are still delivered, with `isResolved`
   * false and only `url` set.
   */
  onDeepLink(listener: LanderLinkListener): LanderSubscription {
    if (typeof listener !== 'function') throw invalidArgument('onDeepLink: listener must be a function')
    return dispatcher.subscribe(listener)
  },

  /**
   * The link that launched the app, or null.
   *
   * On a first launch this may be a deferred link (when the API recovers
   * one), so it waits for the launch report in that case. The launch link is
   * delivered once: if `onDeepLink` or an earlier call already delivered it,
   * this resolves null, and once this has been called `onDeepLink` will not
   * deliver it. Rejects with `not_initialized` before `initialize`.
   */
  async getInitialLink(): Promise<LanderLink | null> {
    return requireClient('getInitialLink').getInitialLink()
  },

  /**
   * Creates a short link from inside the app, for share and invite flows.
   *
   * The slug is always random and the domain is the project's default domain.
   * Rejects with `LanderError` on failure. Retries wait at most 10 seconds in
   * total, so a long `Retry-After` comes back as an error with `retryAfter`.
   */
  async createLink(options: CreateLinkOptions = {}): Promise<LanderShortLink> {
    const c = requireClient('createLink')
    const path = options.path ?? '/'
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw invalidArgument('createLink: path must start with /')
    }
    const params = options.params ?? {}
    for (const [k, v] of Object.entries(params)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw invalidArgument(`createLink: params.${k} must be a string, number or boolean`)
      }
    }
    const body: Json = { deepLinkPath: path, params }
    const optional = [
      'title',
      'campaign',
      'channel',
      'iosFallbackUrl',
      'androidFallbackUrl',
      'webFallbackUrl',
      'ogTitle',
      'ogDescription',
      'ogImageUrl',
    ] as const
    for (const field of optional) {
      const value = options[field]
      if (value !== undefined && value !== null) body[field] = value
    }
    if (options.tags !== undefined && options.tags.length > 0) body.tags = options.tags
    if (options.expiresAt !== undefined && options.expiresAt !== null) {
      const date = options.expiresAt instanceof Date ? options.expiresAt : new Date(options.expiresAt)
      if (Number.isNaN(date.getTime())) throw invalidArgument('createLink: expiresAt is not a valid date')
      body.expiresAt = date.toISOString()
    }
    return c.createLink(body)
  },

  /**
   * Claims the link your backend handed off to this user, after sign in.
   *
   * Your server binds a link to one of its users with `POST /v1/handoffs`
   * (secret key). After that user signs in to the app, call this with the
   * same `userId` to get that link (`isDeferred` true, `confidence`
   * deterministic, `method` `authenticated_handoff`), or null when nothing is
   * pending. The link is only returned, never also sent to `onDeepLink`, so
   * navigate with it yourself. Use an ID that cannot be guessed.
   */
  async claimHandoff(userId: string): Promise<LanderLink | null> {
    const c = requireClient('claimHandoff')
    const id = typeof userId === 'string' ? userId.trim() : ''
    if (id.length === 0 || id.length > 256) {
      throw invalidArgument('claimHandoff: userId must be 1 to 256 characters')
    }
    return c.claimHandoff(id)
  },

  /**
   * Records a custom event, for example a signup or a purchase.
   *
   * The event is stored on the device first and sent in batches, with
   * retries, so it survives offline periods and app restarts. Each event has
   * a client generated ID, so it is counted once even if it is sent twice.
   * Pass `linkId` (from `LanderLink.linkId`) to attribute the event to the
   * link that brought the user in.
   *
   * Rejects with `invalid_argument` for an empty or too long `name` (max 100),
   * a `linkId` that is not a UUID, or properties that cannot be sent as JSON;
   * never rejects for network errors.
   */
  async trackEvent(
    name: string,
    properties: Record<string, unknown> = {},
    options: TrackEventOptions = {},
  ): Promise<void> {
    return requireClient('trackEvent').trackEvent(name, properties, options?.linkId)
  },

  /**
   * The random ID Lander created for this install, once `initialize` has
   * resolved; null before. Useful when asking for support; it is not tied to
   * the device.
   */
  get installId(): string | null {
    return client?.installId ?? null
  },
}

/**
 * Test hooks for the SDK's own tests. Not part of the public API.
 * @internal
 */
export const LanderTesting = {
  setPlatform(platform: LanderPlatform | null): void {
    testPlatform = platform
  },
  setFetch(fetchImpl: FetchLike | null): void {
    testFetch = fetchImpl
  },
  get client(): LanderClient | null {
    return client
  },
  /** Tears the SDK down so tests can initialize it again. */
  reset(): void {
    client?.dispose()
    dispatcher.close()
    client = null
    started = null
    dispatcher = new LinkDispatcher()
    testPlatform = null
    testFetch = null
  },
}
