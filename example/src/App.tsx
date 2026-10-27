import { useEffect, useState } from 'react'
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Lander, LanderError, useLanderDeepLink, type LanderLink } from 'react-native-lander'

/** The screens of Acme Shop. A real app would use React Navigation or Expo Router. */
type Screen =
  | { name: 'home' }
  | { name: 'product'; id: string; link: LanderLink | null }
  | { name: 'notFound'; route: string; link: LanderLink }

const PRODUCTS = [
  { id: '123', name: 'Trail Runner 2' },
  { id: '456', name: 'City Sneaker' },
]

/** Maps a link's route (for example /product/123) to a screen. */
function screenFor(link: LanderLink): Screen {
  const path = link.route.split('?')[0] ?? '/'
  const product = /^\/product\/([^/]+)$/.exec(path)
  if (product) return { name: 'product', id: product[1]!, link }
  if (path === '/') return { name: 'home' }
  return { name: 'notFound', route: link.route, link }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' })

  // Every link (cold start, warm start, deferred) arrives here once.
  useLanderDeepLink((link) => {
    if (link.isDeferred && link.confidence === 'probabilistic') {
      // A good guess, not a certainty: show the screen, nothing more.
      console.log('[Acme Shop] Probabilistic deferred link', link.route)
    }
    setScreen(screenFor(link))
  })

  return (
    <View style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        {screen.name === 'home' && <Home onOpen={(id) => setScreen({ name: 'product', id, link: null })} />}
        {screen.name === 'product' && (
          <Product id={screen.id} link={screen.link} onBack={() => setScreen({ name: 'home' })} />
        )}
        {screen.name === 'notFound' && (
          <View>
            <Text style={styles.title}>Nothing at {screen.route}</Text>
            <LinkDetails link={screen.link} />
            <Button title="Home" onPress={() => setScreen({ name: 'home' })} />
          </View>
        )}
        <InstallId />
      </ScrollView>
    </View>
  )
}

function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const signIn = async () => {
    try {
      // After sign in, pick up a link your backend handed off to this user.
      const link = await Lander.claimHandoff('8f2c41d0-6a8e-4c55-9a2e-7b1f0c3d4e5f')
      Alert.alert('Handoff', link ? `Open ${link.route}` : 'Nothing pending')
    } catch (e) {
      Alert.alert('Handoff failed', e instanceof LanderError ? e.code : String(e))
    }
  }
  return (
    <View>
      <Text style={styles.title}>Acme Shop</Text>
      {PRODUCTS.map((p) => (
        <Button key={p.id} title={p.name} onPress={() => onOpen(p.id)} />
      ))}
      <Button title="Sign in" onPress={signIn} />
    </View>
  )
}

function Product({ id, link, onBack }: { id: string; link: LanderLink | null; onBack: () => void }) {
  const name = PRODUCTS.find((p) => p.id === id)?.name ?? `Product ${id}`

  const share = async () => {
    try {
      const short = await Lander.createLink({
        path: `/product/${id}`,
        params: { productId: id },
        title: name,
        channel: 'share',
      })
      await Share.share({ message: `${name}: ${short.url}` })
    } catch (e) {
      Alert.alert('Could not create a link', e instanceof LanderError ? e.message : String(e))
    }
  }

  const buy = async () => {
    // Attribute the purchase to the link that opened this screen, if any.
    await Lander.trackEvent('purchase', { productId: id, amount: 49.99, currency: 'USD' }, { linkId: link?.linkId })
    Alert.alert('Thanks!', 'Purchase tracked')
  }

  return (
    <View>
      <Text style={styles.title}>{name}</Text>
      {link && <LinkDetails link={link} />}
      <Button title="Buy" onPress={buy} />
      <Button title="Share" onPress={share} />
      <Button title="Back" onPress={onBack} />
    </View>
  )
}

function LinkDetails({ link }: { link: LanderLink }) {
  const rows: [string, string][] = [
    ['url', link.url],
    ['route', link.route],
    ['resolved', String(link.isResolved)],
    ['confidence', link.confidence],
    ['method', link.method ?? '-'],
    ['deferred', String(link.isDeferred)],
    ['params', JSON.stringify(link.params)],
  ]
  return (
    <View style={styles.card}>
      {rows.map(([k, v]) => (
        <Text key={k} style={styles.row}>
          <Text style={styles.key}>{k}: </Text>
          {v}
        </Text>
      ))}
    </View>
  )
}

function InstallId() {
  const [id, setId] = useState(Lander.installId)
  useEffect(() => {
    if (id !== null) return
    const timer = setInterval(() => setId(Lander.installId), 250)
    return () => clearInterval(timer)
  }, [id])
  return <Text style={styles.footer}>Install ID: {id ?? '(loading)'}</Text>
}

function Button({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fafafa', paddingTop: 48 },
  content: { padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 12 },
  card: { backgroundColor: '#fff', borderRadius: 8, padding: 12, marginBottom: 12 },
  row: { fontFamily: 'Menlo', fontSize: 12, marginVertical: 2 },
  key: { fontWeight: '600' },
  button: { backgroundColor: '#4f46e5', borderRadius: 8, padding: 12, marginVertical: 4 },
  buttonText: { color: '#fff', textAlign: 'center', fontWeight: '600' },
  footer: { marginTop: 24, color: '#666', fontSize: 12 },
})
