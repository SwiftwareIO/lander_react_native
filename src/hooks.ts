import { useEffect, useRef } from 'react'
import type { LanderLink } from './core/models'
import { Lander } from './Lander'

/**
 * Calls `listener` with every deep link while the component is mounted.
 *
 * Subscribes to `Lander.onDeepLink` in an effect and unsubscribes on unmount.
 * The latest `listener` is always used, so it does not need to be memoized.
 * Links that arrived before the component mounted (including the one that
 * launched the app) are replayed to it, so mount it once, near the root,
 * where your navigator is available.
 */
export function useLanderDeepLink(listener: (link: LanderLink) => void): void {
  const latest = useRef(listener)
  useEffect(() => {
    latest.current = listener
  })
  useEffect(() => {
    const subscription = Lander.onDeepLink((link) => latest.current(link))
    return () => subscription.remove()
  }, [])
}
