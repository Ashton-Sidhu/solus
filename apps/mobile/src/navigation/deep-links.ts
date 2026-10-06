import type { RootStackParamList } from './routes'

/**
 * The app's `solus://` links: today only a session, which a Live Activity row
 * opens (`solus://thread/<hostId>/<sessionId>`). Anything else is ignored, so
 * an unknown link never moves the person.
 */
export type DeepLinkTarget = { screen: 'Thread'; params: RootStackParamList['Thread'] }

export function parseDeepLink(url: string): DeepLinkTarget | null {
  const match = /^solus:\/\/thread\/([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/.exec(url.trim())
  if (!match) return null
  try {
    const hostId = decodeURIComponent(match[1]!)
    const sessionId = decodeURIComponent(match[2]!)
    return hostId && sessionId ? { screen: 'Thread', params: { hostId, sessionId } } : null
  } catch {
    return null
  }
}
