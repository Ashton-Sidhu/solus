import { planKey } from '../../shared/types'
import type { RouteRef } from '../contexts/workspace/routing/route-registry'

/**
 * The `plan://` / `work://` / `pr://` links an agent writes into its output,
 * read as routes. One vocabulary from here on: the palette, a notification
 * click, and a link in a transcript all end up at the same `openRoute`.
 *
 * Total — an href that names no destination returns null, and the caller falls
 * back to opening it externally.
 */
export function routeForHref(href: string, opts: { title?: string } = {}): RouteRef | null {
  if (!/^(plan|work|pr):\/\//i.test(href) && !/^https:\/\/github\.com\//i.test(href)) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const params = url.searchParams

  if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i)
    if (!match) return null
    const number = Number(match[3])
    return Number.isInteger(number) && number > 0
      ? {
          name: 'prReview',
          params: {
            number,
            title: opts.title,
            expectedRepo: { host: url.hostname, owner: match[1], repo: match[2] },
          },
        }
      : null
  }

  if (href.startsWith('plan://')) {
    const sessionId = params.get('sessionId') ?? ''
    const planToolUseId = params.get('planToolUseId') ?? ''
    const planId = params.get('planId') || (sessionId && planToolUseId ? planKey(sessionId, planToolUseId) : '')
    return planId ? { name: 'plan', params: { planId } } : null
  }

  if (href.startsWith('work://')) {
    const workId = params.get('workId') ?? ''
    return workId ? { name: 'work', params: { workId } } : null
  }

  const number = Number(params.get('number'))
  if (!Number.isInteger(number) || number <= 0) return null
  return { name: 'prReview', params: { number, title: opts.title } }
}
