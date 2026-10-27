import { AppRegistry, Platform } from 'react-native'
import { Lander } from 'react-native-lander'
import App from './src/App'
import { name as appName } from './app.json'

// Runs against a local Lander monorepo (`pnpm dev`) with the seeded demo key.
// The Android emulator reaches the computer at 10.0.2.2. Initialize before the
// first render; links that arrive before the app listens are buffered.
Lander.initialize({
  apiKey: 'pk_test_DemoPublishableKey000000000000',
  baseUrl: Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787',
  enableLogging: true,
}).catch((e) => console.error(e))

AppRegistry.registerComponent(appName, () => App)
