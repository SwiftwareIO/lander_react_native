import { LanderApi, type FetchLike, type Json } from './api'
import { Backoff, sleep } from './backoff'
import type { LinkDispatcher } from './dispatcher'
import { invalidArgument, LanderError } from './errors'
import { EventQueue, type QueuedEvent } from './eventQueue'
import { describe, LanderLogger } from './logger'
import { LanderLink, type LanderShortLink, shortLinkFromJson } from './models'
import type { LanderPlatform, Unsubscribe } from './platform'
import { isWebScheme, parseUrl, queryParameters } from './url'
import { isUuid, URL_NAMESPACE, uuidv4, uuidv5 } from './uuid'
import { landerSdkVersion } from '../version'

export type LanderClientOptions = {
  apiKey: string
  baseUrl: string
  dispatcher: LinkDispatcher
  platform: LanderPlatform
  fetch: FetchLike
  enableLogging?: boolean
  /** Per attempt request timeout in milliseconds. */
  requestTimeout?: number
  /** Delay in milliseconds between `trackEvent` and the flush it schedules. */
  flushDelay?: number
  eventBackoff?: Backoff
  requestBackoff?: Backoff
}

/** The SDK engine behind the `Lander` facade. One per app. */
export class LanderClient {
  static readonly installIdKey = 'install_id'
  static readonly firstLaunchReportedKey = 'first_launch_reported'

  /** Query parameter of a custom scheme URL carrying the Lander link it stands for. */
  static readonly landerLinkParam = 'lander_link'

  /**
   * Repeated identical URLs inside this window (milliseconds) count as one
   * open. iOS and Android can report the same launch URL through more than one
   * callback.
   */
  static readonly duplicateLinkWindow = 2000

  /** Longest `appVersion` and `osVersion` the API accepts. */
  static readonly maxVersionLength = 50

  readonly dispatcher: LinkDispatcher
  readonly platform: LanderPlatform
  readonly logger: LanderLogger
  readonly api: LanderApi
  readonly events: EventQueue

  private readyPromise: Promise<void> | null = null
  private readonly initDonePromise: Promise<void>
  private completeInit!: () => void
  private initCompleted = false
  private linkChain: Promise<void> = Promise.resolve()
  private subscriptions: Unsubscribe[] = []
  private currentInstallId: string | null = null
  private isFirstLaunch = false

  /**
   * Whether the API knows this install (an init succeeded, now or on an
   * earlier launch). Events wait for it: the API rejects events from unknown
   * installs.
   */
  private registered = false
  private registering: Promise<void> | null = null
  private hasInitialLink = false
  private reRegisterTried = false
  private conflictRetried = false
  private lastRawLink: string | null = null
  private lastRawLinkAt = 0
  private disposed = false

  constructor(options: LanderClientOptions) {
    this.dispatcher = options.dispatcher
    this.platform = options.platform
    this.logger = new LanderLogger(options.enableLogging ?? false)
    this.api = new LanderApi({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      logger: this.logger,
      timeout: options.requestTimeout ?? 10_000,
      backoff: options.requestBackoff ?? new Backoff({ base: 500, max: 4000 }),
    })
    this.events = new EventQueue({
      read: (k) => this.platform.read(k),
      write: (k, v) => this.write(k, v),
      sender: (batch) => this.sendEvents(batch),
      logger: this.logger,
      flushDelay: options.flushDelay ?? 2000,
      backoff: options.eventBackoff ?? new Backoff(),
    })
    this.initDonePromise = new Promise((resolve) => {
      this.completeInit = () => {
        this.initCompleted = true
        resolve()
      }
    })
  }

  /** The random install ID, once loaded. */
  get installId(): string | null {
    return this.currentInstallId
  }

  /** Resolves when `POST /v1/sdk/init` has finished (or failed). */
  get initDone(): Promise<void> {
    return this.initDonePromise
  }

  private ready(): Promise<void> {
    return (this.readyPromise ??= this.loadInstall())
  }

  /**
   * Loads local state and hooks up link delivery, then starts the network
   * init in the background. Never rejects.
   */
  async start(): Promise<void> {
    await this.ready()

    // Listen before asking for the launch link, so a link that arrives in
    // between is not missed. Links that arrive meanwhile wait until the launch
    // link is handled, so the same URL reported both ways counts once.
    let early: string[] | null = []
    try {
      this.subscriptions.push(
        this.platform.addLinkListener((url) => {
          if (early !== null) early.push(url)
          else this.onRawLink(url)
        }),
      )
    } catch (e) {
      this.logger.log(`Link listener unavailable: ${describe(e)}`)
    }

    const initialRaw = await this.safe(() => this.platform.getInitialLink(), 'getInitialLink')
    const hasInitial = initialRaw !== null && initialRaw !== ''
    this.hasInitialLink = hasInitial
    if (hasInitial) {
      this.onRawLink(initialRaw, true)
    } else if (!this.isFirstLaunch) {
      // Only a first launch can produce a deferred link, so do not make
      // getInitialLink wait for the network otherwise.
      this.dispatcher.setInitialLink(null)
    }
    const arrived = early
    early = null
    for (const url of arrived) this.onRawLink(url)

    try {
      this.subscriptions.push(this.platform.addAppStateListener((s) => this.onAppStateChange(s)))
    } catch (e) {
      this.logger.log(`App state listener unavailable: ${describe(e)}`)
    }

    void this.init(hasInitial)
    void this.events.load().then(() => this.events.flush())
  }

  private async loadInstall(): Promise<void> {
    let id = await this.safe(() => this.platform.read(LanderClient.installIdKey), 'read install id')
    if (id === null || !isUuid(id)) {
      id = uuidv4()
      await this.write(LanderClient.installIdKey, id)
      this.logger.log(`Created install ID ${id}`)
    }
    this.currentInstallId = id
    const marker = await this.safe(
      () => this.platform.read(LanderClient.firstLaunchReportedKey),
      'read first launch',
    )
    this.isFirstLaunch = marker !== '1'
    this.registered = !this.isFirstLaunch
  }

  /** Starts over with a new install ID, reported as a first launch. */
  private async resetInstall(): Promise<void> {
    const id = uuidv4()
    this.currentInstallId = id
    await this.write(LanderClient.installIdKey, id)
    try {
      await this.platform.delete(LanderClient.firstLaunchReportedKey)
    } catch (e) {
      this.logger.log(`Storage delete failed: ${describe(e)}`)
    }
    this.isFirstLaunch = true
    this.registered = false
    this.logger.log(`Created install ID ${id}`)
  }

  private async init(hasInitialLink: boolean): Promise<void> {
    try {
      await this.registerOnce()
    } catch (e) {
      this.logger.log(`Init failed unexpectedly: ${describe(e)}`)
    } finally {
      if (!hasInitialLink && !this.dispatcher.initialSettled) this.dispatcher.setInitialLink(null)
      if (!this.initCompleted) this.completeInit()
    }
  }

  /**
   * Registers the install and hands a deferred link from the response to the
   * app. Concurrent callers share one request. Never rejects.
   */
  private registerOnce(): Promise<void> {
    return (this.registering ??= this.registerAndDeliver().finally(() => {
      this.registering = null
    }))
  }

  private async registerAndDeliver(): Promise<void> {
    const json = await this.register()
    try {
      const deferred = json?.deferredLink
      // A link that opened the app wins over a deferred one.
      if (deferred === null || typeof deferred !== 'object' || Array.isArray(deferred)) return
      if (this.hasInitialLink) return
      const link = LanderLink.fromJson(deferred as Json)
      this.logger.log(`Deferred link: ${linkSummary(link)}`)
      // Once the launch link is settled (a retried init that succeeded later
      // in the session), this delivers it to onDeepLink instead.
      this.dispatcher.setInitialLink(link)
    } catch (e) {
      this.logger.log(`Could not read the deferred link: ${describe(e)}`)
    }
  }

  /**
   * Retries the registration if no init has succeeded yet, for example after
   * a first launch offline. Returns whether the install is registered.
   */
  private async ensureRegistered(): Promise<boolean> {
    if (!this.registered) await this.registerOnce()
    return this.registered
  }

  /** `POST /v1/sdk/init`. Returns the response, or null on failure. Never rejects. */
  private async register(): Promise<Json | null> {
    try {
      const info = await this.safe(() => this.platform.getPlatformInfo(), 'getPlatformInfo')
      if (info === null || (info.platform !== 'ios' && info.platform !== 'android')) {
        this.logger.log('Unsupported platform, skipping init. Links and events still work locally.')
        return null
      }

      let referrer: string | null = null
      if (this.isFirstLaunch && info.platform === 'android') {
        referrer = await this.safe(
          () => withTimeout(this.platform.getInstallReferrer(), 5000),
          'getInstallReferrer',
        )
        if (referrer !== null && referrer.length > 2048) referrer = referrer.slice(0, 2048)
      }

      const body: Json = {
        installId: this.currentInstallId,
        platform: info.platform,
        appVersion: truncate(info.appVersion),
        sdkVersion: landerSdkVersion,
      }
      if (info.osVersion !== null) body.osVersion = truncate(info.osVersion)
      body.isFirstLaunch = this.isFirstLaunch
      if (referrer !== null && referrer !== '') body.installReferrer = referrer

      const json = await this.api.post('/v1/sdk/init', body, {
        // A stable key for the install report, so a retry after a lost
        // response (even on the next launch) records one install, not two.
        idempotencyKey: this.isFirstLaunch
          ? uuidv5(URL_NAMESPACE, `lander:install:${this.currentInstallId}`)
          : uuidv4(),
        maxAttempts: this.isFirstLaunch ? 3 : 1,
      })
      if (this.isFirstLaunch) {
        // If this marker is lost, the next launch reports a first launch again
        // and gets the same deferred link a second time, so try harder than
        // for other writes before the link is handed to the app.
        if (!(await this.writeWithRetry(LanderClient.firstLaunchReportedKey, '1'))) {
          this.logger.log(
            'Could not save the first launch marker; the next launch may get the deferred link again',
          )
        }
        this.isFirstLaunch = false
      }
      this.registered = true
      this.logger.log('Init ok')
      // Send events that waited for the install to be known.
      void this.events.flush()
      return json
    } catch (e) {
      if (e instanceof LanderError) {
        if (e.code === 'install_id_conflict' && !this.conflictRetried) {
          // The ID belongs to another project or environment, for example after
          // switching from a test key to a live key. Start over with a new one.
          this.conflictRetried = true
          this.logger.log('Install ID belongs to another project, creating a new one')
          await this.resetInstall()
          return this.register()
        }
        this.logger.log(`Init failed: ${e.toString()}`)
        return null
      }
      this.logger.log(`Init failed unexpectedly: ${describe(e)}`)
      return null
    }
  }

  private onRawLink(raw: string, initial = false): void {
    if (this.disposed) return
    const now = Date.now()
    if (
      !initial &&
      raw === this.lastRawLink &&
      now - this.lastRawLinkAt < LanderClient.duplicateLinkWindow
    ) {
      this.logger.log(`Ignoring duplicate link ${raw}`)
      return
    }
    this.lastRawLink = raw
    this.lastRawLinkAt = now
    this.linkChain = this.linkChain
      .then(async () => {
        const link = await this.resolve(raw)
        if (initial) {
          this.dispatcher.setInitialLink(link)
        } else if (link !== null) {
          this.dispatcher.add(link)
        }
      })
      .catch((e: unknown) => {
        this.logger.log(`Link delivery failed for ${raw}: ${describe(e)}`)
        if (initial && !this.dispatcher.initialSettled) this.dispatcher.setInitialLink(null)
      })
  }

  /**
   * Resolves `raw` through the API. Never rejects: unknown links and network
   * failures produce an unresolved link carrying the raw URL.
   */
  private async resolve(raw: string): Promise<LanderLink | null> {
    const parsed = parseUrl(raw)
    if (parsed === null) {
      this.logger.log(`Ignoring unparsable link ${raw}`)
      return null
    }
    let target = raw
    if (!isWebScheme(parsed.scheme)) {
      // Custom scheme URLs are not Lander short links, unless they carry one in
      // `lander_link` (the "Continue in app" page's open button does).
      const carried = queryParameters(parsed.query)[LanderClient.landerLinkParam] ?? ''
      const carriedUrl = parseUrl(carried)
      if (carriedUrl === null || !isWebScheme(carriedUrl.scheme)) return LanderLink.unresolved(raw)
      target = carried
    }
    // Let init register this install first, but never hold a link for long.
    await withTimeout(this.initDone, this.api.timeout).catch(() => {})
    try {
      const json = await this.api.post(
        '/v1/sdk/resolve',
        { installId: this.currentInstallId, url: target },
        { idempotencyKey: uuidv4(), maxAttempts: 2 },
      )
      const link = LanderLink.fromJson(json, raw)
      this.logger.log(`Resolved ${linkSummary(link)}`)
      return link
    } catch (e) {
      if (e instanceof LanderError) {
        this.logger.log(
          e.statusCode === 404 ? `Not a Lander link: ${raw}` : `Resolve failed for ${raw}: ${e.toString()}`,
        )
      } else {
        this.logger.log(`Resolve returned an unexpected response for ${raw}: ${describe(e)}`)
      }
      return LanderLink.unresolved(raw)
    }
  }

  getInitialLink(): Promise<LanderLink | null> {
    return this.dispatcher.takeInitialLink()
  }

  /**
   * `POST /v1/sdk/handoffs/claim`. Returns the link the customer's backend
   * bound to `userId`, or null. The link is returned only, never also sent to
   * `onDeepLink`, so the app navigates once.
   */
  async claimHandoff(userId: string): Promise<LanderLink | null> {
    await this.ready()
    // The API only knows installs that went through init. If it failed, try
    // again now.
    await this.initDone
    if (!(await this.ensureRegistered())) {
      throw new LanderError({
        code: 'install_not_registered',
        message: 'Lander could not register this install yet (offline?); try again later',
      })
    }
    const json = await this.api.post(
      '/v1/sdk/handoffs/claim',
      { installId: this.currentInstallId, userId },
      // One key per call, reused across its retries: a retry after a lost
      // response gets the same link instead of nothing.
      { idempotencyKey: uuidv4(), maxAttempts: 3 },
    )
    const deferred = json.deferredLink
    if (deferred === null || deferred === undefined) {
      this.logger.log('No pending handoff')
      return null
    }
    const link =
      typeof deferred === 'object' && !Array.isArray(deferred)
        ? LanderLink.fromJson(deferred as Json)
        : null
    if (link === null || !link.isResolved) {
      throw new LanderError({ code: 'invalid_response', message: 'Unexpected claimHandoff response' })
    }
    this.logger.log(`Handoff: ${linkSummary(link)}`)
    return link
  }

  async createLink(body: Json): Promise<LanderShortLink> {
    await this.ready()
    const json = await this.api.post(
      '/v1/sdk/links',
      // installId lets the API rate limit per install instead of per IP.
      { ...body, installId: this.currentInstallId },
      { idempotencyKey: uuidv4(), maxAttempts: 3 },
    )
    try {
      return shortLinkFromJson(json)
    } catch (e) {
      throw new LanderError({
        code: 'invalid_response',
        message: `Unexpected createLink response: ${describe(e)}`,
      })
    }
  }

  async trackEvent(
    name: string,
    properties: Record<string, unknown>,
    linkId: string | null | undefined,
  ): Promise<void> {
    if (typeof name !== 'string' || name.length === 0 || name.length > 100) {
      throw invalidArgument('trackEvent: name must be 1 to 100 characters')
    }
    // Validate here: one bad event would make the API reject its whole batch.
    if (linkId !== null && linkId !== undefined && !isUuid(linkId)) {
      throw invalidArgument('trackEvent: linkId must be a Lander link ID (UUID)')
    }
    const props = toJsonObject(properties)
    const event: QueuedEvent = { id: uuidv4(), type: 'custom', name }
    if (linkId !== null && linkId !== undefined) event.linkId = linkId
    event.properties = props
    event.occurredAt = new Date().toISOString()
    await this.events.add(event)
  }

  private async sendEvents(batch: QueuedEvent[]): Promise<void> {
    await this.ready()
    // An init that failed is retried here, so events do not wait for the next
    // launch.
    if (!(await this.ensureRegistered())) {
      // Retried with backoff, and flushed as soon as init succeeds.
      throw new LanderError({
        code: 'install_not_registered',
        message: 'Waiting for init to succeed',
      })
    }
    const ids = batch.map((e) => e.id).sort()
    try {
      await this.api.post(
        '/v1/sdk/events',
        { installId: this.currentInstallId, events: batch },
        { idempotencyKey: uuidv5(URL_NAMESPACE, `lander:events:${ids.join(',')}`) },
      )
    } catch (e) {
      if (!(e instanceof LanderError) || e.code !== 'install_not_found' || this.reRegisterTried) {
        throw e
      }
      // The API lost this install (for example a reset local database).
      // Register it again once, and keep the events meanwhile.
      this.reRegisterTried = true
      this.registered = false
      this.isFirstLaunch = true
      this.logger.log('API does not know this install, registering it again')
      void this.registerOnce()
      // Without a status code the queue treats it as retryable.
      throw new LanderError({ code: e.code, message: e.message })
    }
  }

  /** Called with React Native `AppState` values. */
  onAppStateChange(state: string): void {
    if (this.disposed) return
    if (state === 'background' || state === 'inactive') {
      void this.events.flush()
    } else if (state === 'active' && !this.registered) {
      // The init at launch failed (offline?). Back in the foreground is a good
      // moment to try again, without waiting for the next launch.
      void this.registerOnce()
    }
  }

  private async write(key: string, value: string): Promise<void> {
    try {
      await this.platform.write(key, value)
    } catch (e) {
      this.logger.log(`Storage write failed for ${key}: ${describe(e)}`)
    }
  }

  /** `write` with up to `attempts` tries. Never rejects. */
  private async writeWithRetry(key: string, value: string, attempts = 3): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.platform.write(key, value)
        return true
      } catch (e) {
        this.logger.log(`Storage write failed for ${key} (try ${i + 1} of ${attempts}): ${describe(e)}`)
        if (i < attempts - 1) await sleep(100 * (i + 1))
      }
    }
    return false
  }

  private async safe<T>(call: () => Promise<T | null>, what: string): Promise<T | null> {
    try {
      return (await call()) ?? null
    } catch (e) {
      this.logger.log(`${what} failed: ${describe(e)}`)
      return null
    }
  }

  /** Stops listening and cancels timers. */
  dispose(): void {
    this.disposed = true
    this.events.dispose()
    for (const s of this.subscriptions) {
      try {
        s.remove()
      } catch {
        // Already removed.
      }
    }
    this.subscriptions = []
  }
}

function truncate(version: string): string {
  return version.length > LanderClient.maxVersionLength
    ? version.slice(0, LanderClient.maxVersionLength)
    : version
}

/** Rejects with a timeout error when `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Deep copies `properties` as JSON, failing fast on values that cannot be sent
 * (functions, symbols, bigints, cycles, Dates and other class instances).
 */
function toJsonObject(properties: unknown): Record<string, unknown> {
  if (properties === undefined || properties === null) return {}
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    throw invalidArgument('trackEvent: properties must be an object')
  }
  const seen = new Set<object>()
  const check = (value: unknown, path: string): void => {
    if (value === null) return
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return
      case 'number':
        if (!Number.isFinite(value)) {
          throw invalidArgument(`trackEvent: properties.${path} must be a finite number`)
        }
        return
      case 'object': {
        const proto = Object.getPrototypeOf(value) as unknown
        if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
          throw invalidArgument(
            `trackEvent: properties.${path} must be JSON encodable (convert class instances such as Date first)`,
          )
        }
        if (seen.has(value)) throw invalidArgument(`trackEvent: properties.${path} is circular`)
        seen.add(value)
        for (const [k, v] of Object.entries(value)) check(v, path === '' ? k : `${path}.${k}`)
        seen.delete(value)
        return
      }
      default:
        throw invalidArgument(`trackEvent: properties.${path} must be JSON encodable (got ${typeof value})`)
    }
  }
  check(properties, '')
  return JSON.parse(JSON.stringify(properties)) as Record<string, unknown>
}

/** A readable one line summary of a link for the logs. */
export function linkSummary(link: LanderLink): string {
  if (!link.isResolved) return `LanderLink(unresolved, url: ${link.url})`
  return (
    `LanderLink(${link.linkId}, path: ${link.path}, params: ${JSON.stringify(link.params)}, url: ${link.url}` +
    `${link.isDeferred ? ', deferred' : ''}, ${link.confidence}${link.method === null ? '' : ` via ${link.method}`})`
  )
}
