/**
 * Facts about the host app sent with `POST /v1/sdk/init`. Deliberately small:
 * no device model, no locale, no advertising identifiers.
 */
export type LanderPlatformInfo = {
  /** `ios` or `android`. Anything else skips the launch report. */
  platform: string
  appVersion: string
  osVersion: string | null
}

export type Unsubscribe = { remove(): void }

/** The native side of the SDK. Tests replace it with a fake. */
export interface LanderPlatform {
  /** The URL that launched the app, if any. Handed out once. */
  getInitialLink(): Promise<string | null>

  /** URLs that arrive while the app is running (warm start). */
  addLinkListener(listener: (url: string) => void): Unsubscribe

  /** App state changes: `active`, `background` or `inactive`. */
  addAppStateListener(listener: (state: string) => void): Unsubscribe

  getPlatformInfo(): Promise<LanderPlatformInfo>

  /**
   * Raw Play Install Referrer string. Android only; null elsewhere or when the
   * Play Store is unavailable.
   */
  getInstallReferrer(): Promise<string | null>

  /**
   * Small key value storage kept out of device backups, so the install ID and
   * event queue never move to another device.
   */
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
