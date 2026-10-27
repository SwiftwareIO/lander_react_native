import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

/**
 * Codegen spec of the native module (`RNLander`), implemented in
 * `android/src/main/java/link/lander/reactnative/RNLanderModule.kt` and
 * `ios/RNLander.mm` (forwarding to `ios/RNLanderImpl.swift`).
 */
export interface Spec extends TurboModule {
  /** Read once when the module loads. */
  getConstants(): {
    appVersion: string
    osVersion: string
  }

  /**
   * Android: the URL of the activity's launch intent, handed out once, or null.
   * Links from later intents are sent as `LanderLink` device events. iOS
   * resolves null; links come from React Native's `Linking` there.
   */
  getInitialLink(): Promise<string | null>

  /** Android: the raw Play Install Referrer string, or null. iOS resolves null. */
  getInstallReferrer(): Promise<string | null>

  /** Key value storage excluded from device backups. Keys match `^[a-z0-9_]{1,64}$`. */
  storageRead(key: string): Promise<string | null>
  storageWrite(key: string, value: string): Promise<void>
  storageDelete(key: string): Promise<void>

  // Required by NativeEventEmitter.
  addListener(eventName: string): void
  removeListeners(count: number): void
}

export default TurboModuleRegistry.get<Spec>('RNLander')
