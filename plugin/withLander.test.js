const withLander = require('./withLander')
const { addAssociatedDomains, addIntentFilters, addUrlSchemes, parseOptions } = withLander

function manifest(extraFilters = []) {
  return {
    manifest: {
      application: [
        {
          activity: [
            {
              $: { 'android:name': '.MainActivity' },
              'intent-filter': [
                {
                  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
                },
                ...extraFilters,
              ],
            },
          ],
        },
      ],
    },
  }
}

const filtersOf = (m) => m.manifest.application[0].activity[0]['intent-filter']

describe('parseOptions', () => {
  test('requires domains and normalizes them', () => {
    expect(() => parseOptions(undefined)).toThrow(/domains/)
    expect(() => parseOptions({ domains: [] })).toThrow(/domains/)
    expect(() => parseOptions({ domains: ['https://acme.golander.link'] })).toThrow(/bare host/)
    expect(() => parseOptions({ domains: ['acme.golander.link/p-1'] })).toThrow(/bare host/)
    expect(parseOptions({ domains: [' Acme.Golander.Link ', 'acme.golander.link'] })).toEqual({
      domains: ['acme.golander.link'],
      schemes: [],
    })
  })

  test('accepts one scheme or a list, without ://', () => {
    expect(parseOptions({ domains: ['a.golander.link'], scheme: 'acmeshop' }).schemes).toEqual(['acmeshop'])
    expect(parseOptions({ domains: ['a.golander.link'], scheme: ['a', 'b'] }).schemes).toEqual(['a', 'b'])
    expect(() => parseOptions({ domains: ['a.golander.link'], scheme: 'acmeshop://' })).toThrow(/scheme/)
  })
})

describe('iOS', () => {
  test('adds applinks entries once', () => {
    const e = addAssociatedDomains({ [`com.apple.developer.associated-domains`]: ['applinks:other.example'] }, [
      'acme.golander.link',
    ])
    addAssociatedDomains(e, ['acme.golander.link'])
    expect(e['com.apple.developer.associated-domains']).toEqual([
      'applinks:other.example',
      'applinks:acme.golander.link',
    ])
  })

  test('adds a URL scheme unless it is registered', () => {
    const plist = addUrlSchemes({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['com.acme.shop'] }] }, ['acmeshop'])
    addUrlSchemes(plist, ['acmeshop'])
    expect(plist.CFBundleURLTypes).toEqual([
      { CFBundleURLSchemes: ['com.acme.shop'] },
      { CFBundleURLSchemes: ['acmeshop'] },
    ])
  })
})

describe('Android', () => {
  test('adds a verified https filter and a separate scheme filter, once', () => {
    const m = manifest()
    addIntentFilters(m, { domains: ['acme.golander.link', 'go.acme.com'], schemes: ['acmeshop'] })
    addIntentFilters(m, { domains: ['acme.golander.link', 'go.acme.com'], schemes: ['acmeshop'] })
    const filters = filtersOf(m)
    expect(filters).toHaveLength(3)
    expect(filters[1]).toEqual({
      $: { 'android:autoVerify': 'true' },
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      category: [
        { $: { 'android:name': 'android.intent.category.DEFAULT' } },
        { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
      ],
      data: [
        { $: { 'android:scheme': 'https', 'android:host': 'acme.golander.link' } },
        { $: { 'android:scheme': 'https', 'android:host': 'go.acme.com' } },
      ],
    })
    expect(filters[2].$).toBeUndefined()
    expect(filters[2].data).toEqual([{ $: { 'android:scheme': 'acmeshop' } }])
  })
})

describe('withLander', () => {
  test('registers the iOS and Android mods and skips the scheme Expo already adds', () => {
    const config = withLander(
      { name: 'Acme Shop', slug: 'acme-shop', scheme: 'acmeshop' },
      { domains: ['acme.golander.link'], scheme: 'acmeshop' },
    )
    expect(Object.keys(config.mods.ios).sort()).toEqual(['entitlements'])
    expect(Object.keys(config.mods.android)).toEqual(['manifest'])
  })

  test('adds the Info.plist mod for a new scheme', () => {
    const config = withLander({ name: 'Acme Shop', slug: 'acme-shop' }, { domains: ['acme.golander.link'], scheme: 'acmeshop' })
    expect(Object.keys(config.mods.ios).sort()).toEqual(['entitlements', 'infoPlist'])
  })

  test('fails early without domains', () => {
    expect(() => withLander({ name: 'Acme Shop', slug: 'acme-shop' }, {})).toThrow(/domains/)
  })
})
