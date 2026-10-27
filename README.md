# react-native-lander

Deep linking without the fuss. The React Native SDK for [Lander](https://golander.link): it catches every link that opens your app (Universal Links, App Links, custom scheme URLs), asks Lander what the link means, and hands your app one tidy `LanderLink` with the route to open and the data you attached to it. Deferred links after an install, short links from the app and offline safe conversion events are included.

```ts
import { Lander } from 'react-native-lander'

Lander.initialize({ apiKey: 'pk_live_...' })
Lander.onDeepLink((link) => navigate(link.route))
```

Full documentation: [docs.golander.link/docs/react-native](https://docs.golander.link/docs/react-native).

## Requirements

| | Minimum |
| --- | --- |
| React Native | 0.76 (New Architecture or the old architecture through interop) |
| iOS | 15.1 |
| Android | API 24 (Android 7.0) |
| Expo | A development build or `expo prebuild` (Expo Go cannot load the native module) |

## Install

```bash
npm install react-native-lander
cd ios && pod install
```

Autolinking adds the native module (`RNLander`) on both platforms. The Android library declares the `INTERNET` permission and depends on the Play Install Referrer library; the iOS pod ships a privacy manifest.

### Expo

Add the config plugin with your Lander link domains, then run `npx expo prebuild` (or build with EAS):

```json
{
  "expo": {
    "scheme": "acmeshop",
    "plugins": [["react-native-lander", { "domains": ["acme.golander.link"] }]]
  }
}
```

The plugin adds `applinks:<domain>` to the iOS entitlements and a verified (`autoVerify`) https intent filter to the Android main activity. Pass `"scheme": "acmeshop"` in the plugin options to register a custom scheme when you do not use Expo's top level `scheme`.

### Bare React Native: iOS

1. In **Build > Platforms** in the Lander dashboard, fill in the iOS app (Team ID, bundle ID, optional App Store ID and URI scheme).
2. In Xcode, add the **Associated Domains** capability with `applinks:acme.golander.link` (your link domain).
3. Optional: add your custom scheme to `CFBundleURLTypes` in `Info.plist`.
4. Forward URLs to React Native's `RCTLinkingManager`, which the SDK reads through `Linking`. Apps generated with a `SceneDelegate` (React Native 0.79 and later templates) already do this. Apps with only an `AppDelegate` add:

```swift
// AppDelegate.swift
import React

func application(_ app: UIApplication, open url: URL,
                 options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
  RCTLinkingManager.application(app, open: url, options: options)
}

func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                 restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
  RCTLinkingManager.application(application, continue: userActivity,
                                restorationHandler: restorationHandler)
}
```

### Bare React Native: Android

1. In **Build > Platforms**, fill in the Android app (package name and the SHA-256 fingerprints of your debug, upload and Play App Signing keys).
2. Add the intent filters to your main activity in `AndroidManifest.xml`:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="acme.golander.link" />
</intent-filter>
<!-- Optional custom scheme, in its own filter -->
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="acmeshop" />
</intent-filter>
```

Keep `android:launchMode="singleTask"` (the React Native default). Nothing to add in `MainActivity`: the SDK's module reads the launch intent and `onNewIntent` itself, and skips launch intents that Android replays from Recents.

## Initialize

Call `initialize` once, in your entry file, before the first render:

```ts
// index.js
import { AppRegistry } from 'react-native'
import { Lander } from 'react-native-lander'
import App from './App'

Lander.initialize({ apiKey: 'pk_live_...', enableLogging: __DEV__ })

AppRegistry.registerComponent('AcmeShop', () => App)
```

It only waits for local work (the install ID and the launch link); the launch report (`POST /v1/sdk/init`) runs in the background and never rejects because of the network. Only publishable keys (`pk_test_...`, `pk_live_...`) are accepted; anything else rejects with a `LanderError` (`invalid_argument`) that never contains the key.

## Receive links

Links that arrive before anything listens are buffered and replayed to the first listener, and the link that launched the app is delivered exactly once, so subscribe wherever your navigator lives.

### React Navigation

```tsx
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native'
import { useLanderDeepLink, type LanderLink } from 'react-native-lander'

const navigationRef = createNavigationContainerRef<RootStackParamList>()

function open(link: LanderLink) {
  const product = /^\/product\/([^/?]+)/.exec(link.route)
  if (product) navigationRef.navigate('Product', { id: product[1]!, link })
  else navigationRef.navigate('Home')
}

export default function App() {
  const pending = useRef<LanderLink | null>(null)

  useLanderDeepLink((link) => {
    if (navigationRef.isReady()) open(link)
    else pending.current = link // the navigator is not mounted yet
  })

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        if (pending.current) open(pending.current)
        pending.current = null
      }}
    >
      {/* screens */}
    </NavigationContainer>
  )
}
```

Do not also list your Lander domains in React Navigation's `linking` prefixes, or every link navigates twice. `LanderLink` is a frozen plain object, so it is fine as a navigation param.

### Expo Router

```tsx
// app/_layout.tsx
import { router, Stack } from 'expo-router'
import { useLanderDeepLink } from 'react-native-lander'

export default function RootLayout() {
  useLanderDeepLink((link) => router.push(link.route))
  return <Stack />
}
```

```ts
// app/+native-intent.tsx: let Lander handle its own links
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (path.includes('acme.golander.link') || path.startsWith('acmeshop:')) return null
  return path
}
```

## The rest of the API

| Member | What it does |
| --- | --- |
| `Lander.initialize(options)` | Starts the SDK. Call once, early. |
| `Lander.onDeepLink(listener)` | Calls `listener` with every `LanderLink`. Returns `{ remove() }`. |
| `useLanderDeepLink(listener)` | The same, as a hook that unsubscribes on unmount. |
| `Lander.getInitialLink()` | The link that launched the app (or a deferred link), once. |
| `Lander.claimHandoff(userId)` | After sign in, the link your backend handed off to that user. |
| `Lander.createLink(options)` | Creates a short link, resolves a `LanderShortLink`. |
| `Lander.trackEvent(name, properties?, { linkId? })` | Records a conversion in an offline safe, batched queue. |
| `Lander.installId` | The random ID of this install, once initialized. |

Every method reports its errors through its Promise as a `LanderError` with `code`, `message`, `statusCode`, `retryAfter` (seconds) and `isRetryable`.

## Privacy

A random install ID (UUID v4) stored outside backups, no fingerprinting, no advertising IDs, no pasteboard reads. The SDK only talks to Lander's public API (`api.golander.link`).

## Development

The source is mirrored read only at [github.com/SwiftwareIO/lander_react_native](https://github.com/SwiftwareIO/lander_react_native); report issues there. It is developed in the Lander monorepo at `sdk/lander_react_native` (not part of the pnpm workspace) and pushed to the mirror on every merge, so send changes to the monorepo, not the mirror. Releases are described in [RELEASING.md](RELEASING.md).

```bash
npm install
npm run typecheck
npm test
npm run build      # react-native-builder-bob, writes lib/
```

`example/` is Acme Shop, an app that exercises the SDK against a local Lander API (see its README).

## License

MIT
