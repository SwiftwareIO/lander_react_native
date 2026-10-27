import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'

type Listener = (payload: any) => void

const mockRn = {
  os: 'ios',
  native: null as Record<string, any> | null,
  linkingListeners: [] as Listener[],
  deviceListeners: new Map<string, Listener[]>(),
  initialUrl: null as string | null,
}

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockRn.os
    },
  },
  Linking: {
    getInitialURL: async () => mockRn.initialUrl,
    addEventListener: (_: string, l: Listener) => {
      mockRn.linkingListeners.push(l)
      return { remove() {} }
    },
  },
  AppState: { addEventListener: () => ({ remove() {} }) },
  DeviceEventEmitter: {
    addListener: (name: string, l: Listener) => {
      mockRn.deviceListeners.set(name, [...(mockRn.deviceListeners.get(name) ?? []), l])
      return { remove() {} }
    },
  },
  TurboModuleRegistry: { get: () => mockRn.native },
}))

function fakeModule(): Record<string, any> {
  const storage = new Map<string, string>()
  return {
    getConstants: () => ({ appVersion: '3.1.0', osVersion: '14' }),
    getInitialLink: jest.fn(async () => 'https://acme.golander.link/p-123'),
    getInstallReferrer: jest.fn(async () => 'lander_token=abc'),
    storageRead: async (k: string) => storage.get(k) ?? null,
    storageWrite: async (k: string, v: string) => {
      storage.set(k, v)
    },
    storageDelete: async (k: string) => {
      storage.delete(k)
    },
    addListener: () => {},
    removeListeners: () => {},
  }
}

function load(): typeof import('../nativePlatform') {
  let mod!: typeof import('../nativePlatform')
  jest.isolateModules(() => {
    mod = require('../nativePlatform')
  })
  return mod
}

beforeEach(() => {
  mockRn.os = 'ios'
  mockRn.native = null
  mockRn.linkingListeners = []
  mockRn.deviceListeners = new Map()
  mockRn.initialUrl = null
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('iOS', () => {
  test('links come from Linking; platform info and storage from the module', async () => {
    mockRn.native = fakeModule()
    mockRn.initialUrl = 'acmeshop://product/1'
    const p = load().createNativePlatform()
    expect(await p.getInitialLink()).toBe('acmeshop://product/1')
    const got: string[] = []
    p.addLinkListener((u) => got.push(u))
    mockRn.linkingListeners[0]!({ url: 'https://acme.golander.link/p-9' })
    expect(got).toEqual(['https://acme.golander.link/p-9'])
    expect(await p.getPlatformInfo()).toEqual({ platform: 'ios', appVersion: '3.1.0', osVersion: '14' })
    expect(await p.getInstallReferrer()).toBeNull()
    expect(mockRn.native.getInstallReferrer).not.toHaveBeenCalled()
    await p.write('install_id', 'abc')
    expect(await p.read('install_id')).toBe('abc')
    await p.delete('install_id')
    expect(await p.read('install_id')).toBeNull()
  })
})

describe('Android', () => {
  test('links and the install referrer come from the module', async () => {
    mockRn.os = 'android'
    mockRn.native = fakeModule()
    const { createNativePlatform, LINK_EVENT } = load()
    const p = createNativePlatform()
    expect(await p.getInitialLink()).toBe('https://acme.golander.link/p-123')
    const got: string[] = []
    p.addLinkListener((u) => got.push(u))
    expect(mockRn.linkingListeners).toEqual([])
    mockRn.deviceListeners.get(LINK_EVENT)![0]!('acmeshop://product/2')
    expect(got).toEqual(['acmeshop://product/2'])
    expect(await p.getInstallReferrer()).toBe('lander_token=abc')
    expect((await p.getPlatformInfo()).platform).toBe('android')
  })
})

describe('without the native module (Expo Go)', () => {
  test('warns once, keeps storage in memory and has no platform info', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { createNativePlatform } = load()
    const p = createNativePlatform()
    createNativePlatform()
    expect(warn).toHaveBeenCalledTimes(1)
    await p.write('install_id', 'abc')
    expect(await p.read('install_id')).toBe('abc')
    await expect(p.getPlatformInfo()).rejects.toThrow()
    mockRn.initialUrl = 'acmeshop://product/1'
    expect(await p.getInitialLink()).toBe('acmeshop://product/1')
  })
})
