/** Prints SDK diagnostics when logging is enabled. Never logs API keys. */
export class LanderLogger {
  constructor(readonly enabled: boolean) {}

  log(message: string): void {
    if (this.enabled) console.log(`[Lander] ${message}`)
  }
}

/** Formats an unknown thrown value for a log line. */
export function describe(e: unknown): string {
  if (e instanceof Error) return e.toString()
  return String(e)
}
