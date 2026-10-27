import { isWebScheme, parseUrl } from './url'

/**
 * How sure Lander is that a link caused this open or install.
 *
 * - `deterministic`: matched by an exact identifier, for example a Universal
 *   Link or App Link open, an Android install referrer token, the iOS Continue
 *   in app page or an authenticated handoff.
 * - `probabilistic`: matched by coarse signals (OS version, country, click
 *   time) within a short window. Only iOS deferred links of projects that
 *   opted in.
 * - `unattributed`: no link could be tied to this open.
 */
export type LanderConfidence = 'deterministic' | 'probabilistic' | 'unattributed'

/** A link param value. */
export type LanderParamValue = string | number | boolean

/**
 * A deep link delivered to the app.
 *
 * When Lander knows the link, the fields mirror the `ResolvedLink` returned by
 * `POST /v1/sdk/resolve`. When it does not (unknown link, custom scheme URL,
 * or the network was unavailable) only `url` is set, `isResolved` is false and
 * the app can still route on the raw URL.
 *
 * A plain, frozen object: every field (including `route` and `isResolved`) is
 * a data property, so a link can be passed as a navigation param or
 * serialized as JSON.
 */
export interface LanderLink {
  /**
   * The URL that opened the app, exactly as the OS delivered it. For deferred
   * and handed off links, the link's short URL (empty when the API sent none).
   */
  readonly url: string
  /** Lander link ID (a UUID), or null when the link is not known to Lander. */
  readonly linkId: string | null
  /** The canonical short link, for example `https://acme.golander.link/p-123`. */
  readonly shortUrl: string | null
  /** The in app route configured on the link, for example `/product/123`. */
  readonly path: string | null
  /**
   * Where to navigate: `path` when resolved, otherwise the raw URL's path and
   * query. For custom scheme URLs the host counts as the first path segment,
   * so `acmeshop://product/123` gives `/product/123`. Never empty.
   */
  readonly route: string
  /**
   * The link's stored params with the opened URL's query parameters merged
   * over them. Values are strings, numbers or booleans.
   */
  readonly params: Readonly<Record<string, LanderParamValue>>
  readonly campaign: string | null
  readonly channel: string | null
  /**
   * True when the link was recovered after an install or handed off after
   * sign in (a deferred deep link), rather than opened directly.
   */
  readonly isDeferred: boolean
  /** How sure Lander is that this link belongs to this open or install. */
  readonly confidence: LanderConfidence
  /**
   * How the link was tied to this open or install: `universal_link`,
   * `app_link`, `install_referrer`, `landing_page`, `authenticated_handoff` or
   * `probabilistic_match`. Null when unresolved.
   */
  readonly method: string | null
  /** Whether Lander recognized this link (`linkId !== null`). */
  readonly isResolved: boolean
}

/** Fields accepted by `LanderLink.create`. Only `url` is required. */
export type LanderLinkInit = {
  url: string
  linkId?: string | null
  shortUrl?: string | null
  path?: string | null
  params?: Record<string, LanderParamValue>
  campaign?: string | null
  channel?: string | null
  isDeferred?: boolean
  confidence?: LanderConfidence
  method?: string | null
}

function create(init: LanderLinkInit): LanderLink {
  const path = init.path ?? null
  const linkId = init.linkId ?? null
  return Object.freeze({
    url: init.url,
    linkId,
    shortUrl: init.shortUrl ?? null,
    path,
    route: routeOf(init.url, path),
    params: Object.freeze({ ...(init.params ?? {}) }),
    campaign: init.campaign ?? null,
    channel: init.channel ?? null,
    isDeferred: init.isDeferred ?? false,
    confidence: init.confidence ?? 'unattributed',
    method: init.method ?? null,
    isResolved: linkId !== null,
  })
}

/** A link Lander could not resolve. Only the raw `url` is available. */
function unresolved(url: string): LanderLink {
  return create({ url })
}

/**
 * Builds a link from a `ResolvedLink` JSON object. `url` is the URL that
 * opened the app; for deferred links it falls back to the link's own URL.
 *
 * Never throws: fields of an unexpected type are treated as missing, so a
 * partly malformed response still delivers what it can.
 */
function fromJson(json: Record<string, unknown>, url?: string): LanderLink {
  const shortUrl = str(json.url)
  return create({
    url: url ?? (shortUrl !== null && parseUrl(shortUrl) !== null ? shortUrl : ''),
    linkId: str(json.linkId),
    shortUrl,
    path: str(json.path),
    params: linkParams(json.params),
    campaign: str(json.campaign),
    channel: str(json.channel),
    isDeferred: json.isDeferred === true,
    confidence: parseConfidence(json.confidence),
    method: str(json.method),
  })
}

/** Helpers to build links, for example in your own tests. */
export const LanderLink = Object.freeze({ create, unresolved, fromJson })

/** Returns the confidence named by `value`, or `unattributed` for anything else. */
export function parseConfidence(value: unknown): LanderConfidence {
  return value === 'deterministic' || value === 'probabilistic' || value === 'unattributed'
    ? value
    : 'unattributed'
}

function routeOf(url: string, path: string | null): string {
  if (path !== null) return path
  const parsed = parseUrl(url)
  if (parsed === null) return '/'
  let raw =
    !isWebScheme(parsed.scheme) && parsed.host !== '' ? `/${parsed.host}${parsed.path}` : parsed.path
  if (raw === '') raw = '/'
  return parsed.query === null ? raw : `${raw}?${parsed.query}`
}

/** A short link created with `Lander.createLink`. */
export interface LanderShortLink {
  readonly id: string
  /** The shareable URL, for example `https://acme.golander.link/x7Kp2Qa`. */
  readonly url: string
  readonly domain: string
  readonly slug: string
  /** The in app route the link opens (`deepLinkPath` in the API). */
  readonly path: string
  readonly params: Readonly<Record<string, LanderParamValue>>
  readonly title: string | null
  readonly campaign: string | null
  readonly channel: string | null
  readonly tags: readonly string[]
  /** When the link stops working, as an ISO 8601 string, or null. */
  readonly expiresAt: string | null
  /** When the link was created, as an ISO 8601 string, or null. */
  readonly createdAt: string | null
}

/** Parses a link returned by `POST /v1/sdk/links`. Throws when `id` or `url` is missing. */
export function shortLinkFromJson(json: Record<string, unknown>): LanderShortLink {
  const id = str(json.id)
  const url = str(json.url)
  if (id === null || url === null) throw new Error('missing id or url')
  const tags = Array.isArray(json.tags) ? json.tags.map((t) => String(t)) : []
  return Object.freeze({
    id,
    url,
    domain: str(json.domain) ?? '',
    slug: str(json.slug) ?? '',
    path: str(json.deepLinkPath) ?? '/',
    params: Object.freeze(linkParams(json.params)),
    title: str(json.title),
    campaign: str(json.campaign),
    channel: str(json.channel),
    tags: Object.freeze(tags),
    expiresAt: str(json.expiresAt),
    createdAt: str(json.createdAt),
  })
}

function linkParams(value: unknown): Record<string, LanderParamValue> {
  const out: Record<string, LanderParamValue> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
