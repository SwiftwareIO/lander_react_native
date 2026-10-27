/**
 * A small URL parser. React Native's `URL` implementation does not support
 * every getter on every version, so the SDK splits URLs itself (RFC 3986,
 * appendix B).
 */
export type ParsedUrl = {
  /** Lowercase scheme, for example `https` or `acmeshop`. */
  scheme: string
  /** Lowercase host, empty when there is none. */
  host: string
  /** The path as it appears in the URL (still percent encoded). */
  path: string
  /** The query without `?`, or null when the URL has no `?`. */
  query: string | null
}

const URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#.*)?$/

/** Parses an absolute URL. Returns null when it has no scheme or contains whitespace. */
export function parseUrl(raw: string): ParsedUrl | null {
  if (/\s/.test(raw)) return null
  const m = URL_PATTERN.exec(raw)
  if (!m) return null
  const authority = m[3] ?? ''
  // Drop user info and port from the authority.
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  const host = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : (hostPort.split(':')[0] ?? '')
  return {
    scheme: (m[1] ?? '').toLowerCase(),
    host: host.toLowerCase(),
    path: m[4] ?? '',
    query: m[5] === undefined ? null : (m[6] ?? ''),
  }
}

/** Decoded query parameters. The first value wins for repeated keys; `+` is a space. */
export function queryParameters(query: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!query) return out
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = decode(eq === -1 ? part : part.slice(0, eq))
    const value = eq === -1 ? '' : decode(part.slice(eq + 1))
    if (key !== null && value !== null && !(key in out)) out[key] = value
  }
  return out
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

export function isWebScheme(scheme: string): boolean {
  return scheme === 'http' || scheme === 'https'
}
