import type { LanderLink } from './models'

/** Returned by `Lander.onDeepLink`. Call `remove()` to stop listening. */
export type LanderSubscription = { remove(): void }

export type LanderLinkListener = (link: LanderLink) => void

type Pending = { link: LanderLink; initial: boolean }

/**
 * Delivers links to the app without losing or doubling any.
 *
 * - Links that arrive while nobody listens are buffered and replayed, in
 *   order, to the next listener. This covers cold starts and links that arrive
 *   before the navigator is ready.
 * - The link that launched the app is delivered exactly once: through
 *   `takeInitialLink` when the app asks for it before a listener received it,
 *   otherwise to the listeners. Later `takeInitialLink` calls return null.
 */
export class LinkDispatcher {
  private readonly listeners = new Set<LanderLinkListener>()
  private readonly buffer: Pending[] = []
  private initialSettledFlag = false
  private readonly initialPromise: Promise<LanderLink | null>
  private resolveInitial!: (link: LanderLink | null) => void
  private initialRequested = false
  private initialOnListeners = false
  private initialTaken = false
  private drainScheduled = false
  private closed = false

  constructor() {
    this.initialPromise = new Promise((resolve) => {
      this.resolveInitial = resolve
    })
  }

  /** Whether the launch link is known (it may be null). */
  get initialSettled(): boolean {
    return this.initialSettledFlag
  }

  get hasListeners(): boolean {
    return this.listeners.size > 0
  }

  /**
   * Adds a listener. Buffered links are replayed to it asynchronously (in a
   * microtask), never during this call.
   */
  subscribe(listener: LanderLinkListener): LanderSubscription {
    // Wrap so the same function can be added twice and removed independently.
    const entry: LanderLinkListener = (link) => listener(link)
    this.listeners.add(entry)
    if (this.buffer.length > 0) this.scheduleDrain()
    return {
      remove: () => {
        this.listeners.delete(entry)
      },
    }
  }

  /** Sets the link that launched the app. Only the first call counts. */
  setInitialLink(link: LanderLink | null): void {
    if (this.initialSettledFlag) {
      if (link !== null) this.add(link)
      return
    }
    this.initialSettledFlag = true
    this.resolveInitial(link)
    if (link === null || this.initialRequested) return
    this.emit({ link, initial: true })
  }

  /** Delivers a link that arrived while the app was running. */
  add(link: LanderLink): void {
    this.emit({ link, initial: false })
  }

  /**
   * Returns the launch link unless a listener or an earlier call already
   * received it.
   */
  async takeInitialLink(): Promise<LanderLink | null> {
    this.initialRequested = true
    const link = await this.initialPromise
    if (this.initialOnListeners || this.initialTaken) return null
    this.initialTaken = true
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i]!.initial) this.buffer.splice(i, 1)
    }
    return link
  }

  private emit(pending: Pending): void {
    if (this.closed) return
    if (this.listeners.size > 0 && this.buffer.length === 0) {
      this.deliver(pending)
    } else {
      this.buffer.push(pending)
      if (this.listeners.size > 0) this.scheduleDrain()
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    void Promise.resolve().then(() => {
      this.drainScheduled = false
      this.drain()
    })
  }

  private drain(): void {
    while (this.buffer.length > 0 && this.listeners.size > 0) {
      this.deliver(this.buffer.shift()!)
    }
  }

  private deliver(pending: Pending): void {
    if (pending.initial) {
      if (this.initialRequested) return
      this.initialOnListeners = true
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(pending.link)
      } catch (e) {
        // Report the app's error without breaking delivery to other listeners.
        setTimeout(() => {
          throw e
        }, 0)
      }
    }
  }

  /** Stops delivering links. */
  close(): void {
    this.closed = true
    this.listeners.clear()
    this.buffer.length = 0
  }
}
