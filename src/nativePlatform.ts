import { AppState, DeviceEventEmitter, Linking, Platform } from 'react-native'
import type { LanderPlatform, LanderPlatformInfo, Unsubscribe } from './core/platform'
import NativeRNLander from './native/NativeRNLander'

/** Name of the device event the Android module sends for links from new intents. */
export const LINK_EVENT = 'LanderLink'

let warned = false

function warnNotLinked(): void {
  if (warned) return
  warned = true
  console.warn(
    "[Lander] The react-native-lander native module is not linked, so the install ID is kept in memory and the launch report is skipped. Rebuild the app after installing the package (with Expo, use a development build: Expo Go cannot load it).",
  )
}

/** The React Native side: `Linking` and `AppState` from React Native plus the RNLander module. */
export function createNativePlatform(): LanderPlatform {
  const native = NativeRNLander ?? null
  if (native === null) warnNotLinked()
  const memory = new Map<string, string>()
  // On Android the module also delivers links; on iOS React Native's Linking does.
  const android = Platform.OS === 'android' ? native : null

  return {
    async getInitialLink(): Promise<string | null> {
      // Android: the module skips launch intents replayed from Recents, which
      // Linking.getInitialURL would deliver again.
      if (android !== null) return (await android.getInitialLink()) ?? null
      return (await Linking.getInitialURL()) ?? null
    },

    addLinkListener(listener: (url: string) => void): Unsubscribe {
      if (android !== null) {
        return DeviceEventEmitter.addListener(LINK_EVENT, (url: unknown) => {
          if (typeof url === 'string') listener(url)
        })
      }
      return Linking.addEventListener('url', (event: { url: string }) => listener(event.url))
    },

    addAppStateListener(listener: (state: string) => void): Unsubscribe {
      return AppState.addEventListener('change', (state) => listener(state))
    },

    async getPlatformInfo(): Promise<LanderPlatformInfo> {
      if (native === null) throw new Error('native module not linked')
      const constants = native.getConstants()
      return {
        platform: Platform.OS,
        appVersion: constants.appVersion || '0.0.0',
        osVersion: constants.osVersion || null,
      }
    },

    async getInstallReferrer(): Promise<string | null> {
      if (android === null) return null
      return (await android.getInstallReferrer()) ?? null
    },

    async read(key: string): Promise<string | null> {
      if (native === null) return memory.get(key) ?? null
      return (await native.storageRead(key)) ?? null
    },

    async write(key: string, value: string): Promise<void> {
      if (native === null) {
        memory.set(key, value)
        return
      }
      await native.storageWrite(key, value)
    },

    async delete(key: string): Promise<void> {
      if (native === null) {
        memory.delete(key)
        return
      }
      await native.storageDelete(key)
    },
  }
}
