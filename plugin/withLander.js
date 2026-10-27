/**
 * Expo config plugin for react-native-lander.
 *
 * Adds what Universal Links, App Links and an optional custom scheme need, so
 * `npx expo prebuild` (and EAS Build) produce native projects with no manual
 * edits:
 *
 * - iOS: `applinks:<domain>` in the Associated Domains entitlement, and the
 *   custom scheme in `CFBundleURLTypes`.
 * - Android: a verified (`android:autoVerify="true"`) https intent filter for
 *   the domains on the main activity, and an intent filter for the custom
 *   scheme.
 *
 * ```json
 * { "expo": { "plugins": [["react-native-lander", { "domains": ["acme.golander.link"] }]] } }
 * ```
 *
 * The scheme is skipped when it is already the app's top level `scheme`,
 * which Expo sets up itself.
 */

function requireConfigPlugins() {
  try {
    return require('expo/config-plugins')
  } catch {
    return require('@expo/config-plugins')
  }
}

const { AndroidConfig, createRunOncePlugin, withAndroidManifest, withEntitlementsPlist, withInfoPlist } =
  requireConfigPlugins()

const pkg = require('../package.json')

const ASSOCIATED_DOMAINS = 'com.apple.developer.associated-domains'
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
const SCHEME = /^[a-z][a-z0-9+.-]*$/

/**
 * Checks and normalizes the plugin options.
 * @param {unknown} props
 * @returns {{ domains: string[], schemes: string[] }}
 */
function parseOptions(props) {
  const options = props && typeof props === 'object' ? props : {}
  const rawDomains = options.domains
  if (!Array.isArray(rawDomains) || rawDomains.length === 0) {
    throw new Error(
      'react-native-lander: set "domains" to your Lander link domains, for example ["acme.golander.link"]',
    )
  }
  const domains = rawDomains.map((d) => {
    const host = typeof d === 'string' ? d.trim().toLowerCase() : ''
    if (!HOST.test(host)) {
      throw new Error(
        `react-native-lander: "${String(d)}" is not a domain. Use the bare host, without https:// or a path.`,
      )
    }
    return host
  })
  const rawSchemes = options.scheme === undefined ? [] : [].concat(options.scheme)
  const schemes = rawSchemes.map((s) => {
    const scheme = typeof s === 'string' ? s.trim() : ''
    if (!SCHEME.test(scheme)) {
      throw new Error(
        `react-native-lander: "${String(s)}" is not a URL scheme. Use lowercase letters, digits, +, . and -, without ://.`,
      )
    }
    return scheme
  })
  return { domains: [...new Set(domains)], schemes: [...new Set(schemes)] }
}

/** Schemes Expo already sets up from the top level `scheme` field. */
function expoSchemes(config) {
  return config.scheme === undefined ? [] : [].concat(config.scheme).filter((s) => typeof s === 'string')
}

/**
 * Adds `applinks:<domain>` entries to an entitlements plist object.
 * @param {Record<string, unknown>} entitlements
 * @param {string[]} domains
 */
function addAssociatedDomains(entitlements, domains) {
  const current = Array.isArray(entitlements[ASSOCIATED_DOMAINS]) ? entitlements[ASSOCIATED_DOMAINS] : []
  const next = [...current]
  for (const domain of domains) {
    const entry = `applinks:${domain}`
    if (!next.includes(entry)) next.push(entry)
  }
  entitlements[ASSOCIATED_DOMAINS] = next
  return entitlements
}

/**
 * Adds URL schemes to an Info.plist object, unless already registered.
 * @param {Record<string, any>} infoPlist
 * @param {string[]} schemes
 */
function addUrlSchemes(infoPlist, schemes) {
  const types = Array.isArray(infoPlist.CFBundleURLTypes) ? infoPlist.CFBundleURLTypes : []
  const known = new Set(types.flatMap((t) => (Array.isArray(t.CFBundleURLSchemes) ? t.CFBundleURLSchemes : [])))
  const missing = schemes.filter((s) => !known.has(s))
  if (missing.length > 0) types.push({ CFBundleURLSchemes: missing })
  infoPlist.CFBundleURLTypes = types
  return infoPlist
}

const VIEW = { $: { 'android:name': 'android.intent.action.VIEW' } }
const CATEGORIES = [
  { $: { 'android:name': 'android.intent.category.DEFAULT' } },
  { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
]

function filterData(filter) {
  return (filter.data || []).map((d) => (d && d.$) || {})
}

/**
 * Adds the App Links and custom scheme intent filters to the main activity of
 * an AndroidManifest object.
 * @param {any} manifest
 * @param {{ domains: string[], schemes: string[] }} options
 */
function addIntentFilters(manifest, { domains, schemes }) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest)
  const filters = (activity['intent-filter'] = activity['intent-filter'] || [])

  const verifiedHosts = new Set(
    filters
      .filter((f) => f.$ && f.$['android:autoVerify'] === 'true')
      .flatMap(filterData)
      .filter((d) => d['android:scheme'] === 'https' && d['android:host'])
      .map((d) => d['android:host']),
  )
  const hosts = domains.filter((d) => !verifiedHosts.has(d))
  if (hosts.length > 0) {
    // One verified filter for the https domains. Custom schemes stay out of it:
    // mixing them in can stop the filter from verifying.
    filters.push({
      $: { 'android:autoVerify': 'true' },
      action: [VIEW],
      category: CATEGORIES,
      data: hosts.map((host) => ({ $: { 'android:scheme': 'https', 'android:host': host } })),
    })
  }

  const knownSchemes = new Set(filters.flatMap(filterData).map((d) => d['android:scheme']))
  for (const scheme of schemes) {
    if (knownSchemes.has(scheme)) continue
    filters.push({ action: [VIEW], category: CATEGORIES, data: [{ $: { 'android:scheme': scheme } }] })
  }
  return manifest
}

/** @type {import('@expo/config-plugins').ConfigPlugin<{ domains: string[], scheme?: string | string[] }>} */
function withLander(config, props) {
  const { domains, schemes: requested } = parseOptions(props)
  const already = expoSchemes(config)
  const schemes = requested.filter((s) => !already.includes(s))

  config = withEntitlementsPlist(config, (c) => {
    addAssociatedDomains(c.modResults, domains)
    return c
  })
  if (schemes.length > 0) {
    config = withInfoPlist(config, (c) => {
      addUrlSchemes(c.modResults, schemes)
      return c
    })
  }
  config = withAndroidManifest(config, (c) => {
    addIntentFilters(c.modResults, { domains, schemes })
    return c
  })
  return config
}

module.exports = createRunOncePlugin(withLander, pkg.name, pkg.version)
module.exports.parseOptions = parseOptions
module.exports.addAssociatedDomains = addAssociatedDomains
module.exports.addUrlSchemes = addUrlSchemes
module.exports.addIntentFilters = addIntentFilters
