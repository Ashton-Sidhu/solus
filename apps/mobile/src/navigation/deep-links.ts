import type { RootStackParamList } from './routes'

/**
 * The app's `solus://` links: a session, which a Live Activity row opens
 * (`solus://thread/<hostId>/<sessionId>`), and a host's pairing link, which its
 * `/pair` page hands to the app (`solus://pair?link=<pairing link>`). Anything
 * else is ignored, so an unknown link never moves the person.
 */
export type DeepLinkTarget =
  | { screen: 'Thread'; params: RootStackParamList['Thread'] }
  | { screen: 'PairHost'; params: { link: string } }

export function parseDeepLink(url: string): DeepLinkTarget | null {
  const pair = /^solus:\/\/pair\/?\?(.*)$/.exec(url.trim())
  if (pair) {
    const link = new URLSearchParams(pair[1]).get('link')
    // Only an http(s) pairing link: PairHost checks the host before anything is sent.
    return link && /^https?:\/\//i.test(link) ? { screen: 'PairHost', params: { link } } : null
  }
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
