/**
 * UUID helpers without dependencies. React Native has no `crypto` global by
 * default, so random bytes come from `crypto.getRandomValues` when a polyfill
 * provides it and from `Math.random` otherwise. Install IDs and idempotency
 * keys need to be unique, not secret.
 */

const UUID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i

/** Whether `value` is a UUID the Lander API accepts (RFC 9562, like zod's `z.uuid()`). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

type CryptoLike = { getRandomValues<T extends Uint8Array>(array: T): T }

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n)
  const c = (globalThis as { crypto?: CryptoLike }).crypto
  if (c && typeof c.getRandomValues === 'function') {
    try {
      return c.getRandomValues(bytes)
    } catch {
      // Fall through to Math.random.
    }
  }
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

function format(b: Uint8Array): string {
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** A random (version 4) UUID. */
export function uuidv4(): string {
  const b = randomBytes(16)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  return format(b)
}

/** The RFC 4122 URL namespace, as used by the Flutter SDK for its derived keys. */
export const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

/** A name based (version 5, SHA-1) UUID. The same inputs always give the same UUID. */
export function uuidv5(namespace: string, name: string): string {
  const ns = namespace.replace(/-/g, '')
  const nsBytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16)
  const nameBytes = utf8(name)
  const data = new Uint8Array(16 + nameBytes.length)
  data.set(nsBytes)
  data.set(nameBytes, 16)
  const hash = sha1(data).slice(0, 16)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  return format(hash)
}

function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

/** SHA-1 of `data`. Only used to derive version 5 UUIDs, never for security. */
export function sha1(data: Uint8Array): Uint8Array {
  const ml = data.length * 8
  const withPadding = ((data.length + 9 + 63) >> 6) << 6
  const msg = new Uint8Array(withPadding)
  msg.set(data)
  msg[data.length] = 0x80
  const view = new DataView(msg.buffer)
  view.setUint32(withPadding - 8, Math.floor(ml / 0x100000000))
  view.setUint32(withPadding - 4, ml >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let off = 0; off < withPadding; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!
      w[i] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const ov = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h))
  return out
}
