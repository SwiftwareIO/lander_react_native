import { Backoff } from './backoff'
import { LanderError } from './errors'
import { describe, type LanderLogger } from './logger'

/** One queued event, as sent to `POST /v1/sdk/events`. */
export type QueuedEvent = { id: string } & Record<string, unknown>

/** Sends one batch. Rejects with `LanderError` on failure. */
export type EventBatchSender = (events: QueuedEvent[]) => Promise<void>

/**
 * Persistent, deduplicating event queue.
 *
 * Events are stored before they are sent, sent in batches of up to
 * `batchSize`, and removed only after the API accepts them. Retryable failures
 * back off exponentially; events keep their client generated `id`, so a batch
 * that is re-sent after a lost response is deduplicated by the API.
 */
export class EventQueue {
  static readonly storageKey = 'event_queue'

  private readonly read: (key: string) => Promise<string | null>
  private readonly write: (key: string, value: string) => Promise<void>
  private readonly sender: EventBatchSender
  private readonly logger: LanderLogger
  readonly batchSize: number
  /**
   * Oldest events are dropped beyond this size so a long offline period
   * cannot grow storage without bound.
   */
  readonly maxQueueSize: number
  /**
   * Delay in milliseconds between an `add` and the flush it schedules, so
   * bursts of events go out as one batch.
   */
  readonly flushDelay: number
  readonly backoff: Backoff

  private readonly events: QueuedEvent[] = []
  private readonly ids = new Set<string>()
  private loaded: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private flushing: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private halted = false
  private disposed = false

  constructor(options: {
    read: (key: string) => Promise<string | null>
    write: (key: string, value: string) => Promise<void>
    sender: EventBatchSender
    logger: LanderLogger
    batchSize?: number
    maxQueueSize?: number
    flushDelay?: number
    backoff?: Backoff
  }) {
    this.read = options.read
    this.write = options.write
    this.sender = options.sender
    this.logger = options.logger
    this.batchSize = options.batchSize ?? 100
    this.maxQueueSize = options.maxQueueSize ?? 1000
    this.flushDelay = options.flushDelay ?? 2000
    this.backoff = options.backoff ?? new Backoff()
  }

  /** Events waiting to be sent, oldest first. */
  get pending(): readonly QueuedEvent[] {
    return [...this.events]
  }

  /** Loads the persisted queue. Safe to call more than once. */
  load(): Promise<void> {
    return (this.loaded ??= this.doLoad())
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await this.read(EventQueue.storageKey)
      if (raw === null || raw === '') return
      const decoded: unknown = JSON.parse(raw)
      if (!Array.isArray(decoded)) return
      for (const e of decoded) {
        if (e !== null && typeof e === 'object' && typeof (e as QueuedEvent).id === 'string') {
          this.insert(e as QueuedEvent)
        }
      }
      this.logger.log(`Loaded ${this.events.length} queued events`)
    } catch (e) {
      this.logger.log(`Could not load the event queue, starting empty: ${describe(e)}`)
    }
  }

  /**
   * Adds `event` (which must have a unique `id`) and schedules a flush.
   * Events with an `id` that is already queued are ignored.
   */
  async add(event: QueuedEvent): Promise<void> {
    await this.load()
    if (!this.insert(event)) return
    while (this.events.length > this.maxQueueSize) {
      const dropped = this.events.shift()
      if (dropped) this.ids.delete(dropped.id)
    }
    await this.persist()
    this.schedule(this.flushDelay)
  }

  private insert(event: QueuedEvent): boolean {
    if (this.ids.has(event.id)) return false
    this.ids.add(event.id)
    this.events.push(event)
    return true
  }

  /** Sends everything that is queued now. Concurrent calls share one flush. */
  flush(): Promise<void> {
    return (this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null
    }))
  }

  private async doFlush(): Promise<void> {
    await this.load()
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    while (this.events.length > 0 && !this.halted && !this.disposed) {
      const batch = this.events.slice(0, this.batchSize)
      try {
        await this.sender(batch)
        this.failures = 0
        this.remove(batch)
        this.logger.log(`Sent ${batch.length} events`)
      } catch (e) {
        if (e instanceof LanderError) {
          if (e.isRetryable) {
            let wait = this.backoff.delay(this.failures++)
            if (e.retryAfter !== null && e.retryAfter * 1000 > wait) wait = e.retryAfter * 1000
            this.logger.log(`Event batch failed (${e.code}), retrying in ${Math.round(wait / 1000)}s`)
            this.schedule(wait, true)
            return
          }
          if (e.statusCode === 401 || e.statusCode === 403) {
            // A bad key will not fix itself. Keep the events for the next launch.
            this.logger.log(
              `Event batch rejected (${e.code}): check the API key. Pausing until next launch.`,
            )
            this.halted = true
            return
          }
          // Validation errors: the batch will never be accepted, drop it so it
          // does not block the queue forever.
          this.logger.log(
            `Dropping ${batch.length} events rejected by the API (${e.code}): ${e.message}`,
          )
          this.remove(batch)
        } else {
          this.logger.log(`Event batch failed unexpectedly: ${describe(e)}`)
          this.schedule(this.backoff.delay(this.failures++), true)
          return
        }
      } finally {
        await this.persist()
      }
    }
  }

  private remove(batch: QueuedEvent[]): void {
    const sent = new Set(batch.map((e) => e.id))
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (sent.has(this.events[i]!.id)) this.events.splice(i, 1)
    }
    for (const id of sent) this.ids.delete(id)
  }

  /**
   * Schedules a flush. A pending timer (a scheduled flush or a backoff) is
   * kept, so new events never cut a backoff short; a `retry` replaces it.
   */
  private schedule(delay: number, retry = false): void {
    if (this.disposed || this.halted) return
    if (this.timer !== null && !retry) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delay)
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.events)
    return (this.writeChain = this.writeChain
      .then(() => this.write(EventQueue.storageKey, snapshot))
      .catch((e: unknown) => {
        this.logger.log(`Could not persist the event queue: ${describe(e)}`)
      }))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
