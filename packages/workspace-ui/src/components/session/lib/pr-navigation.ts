import { routeForHref } from '../../../lib/agent-links'
import type { RouteRef } from '../../../contexts/workspace/routing/route-registry'
import type { PrChoice } from './sidebar-rows'

interface PrNavigation {
  route: RouteRef<'prReview'>
  sourceUrl: string | undefined
}

/** Task choices use the same URL identity and current workspace as transcript links.
 * Number-only choices can still open, but cannot supply a browser fallback. */
export function prNavigation(choice: PrChoice): PrNavigation {
  const sourceUrl = choice.url || choice.pullRequest?.url || undefined
  const title = choice.pullRequest?.title || choice.title
  const linkRoute = sourceUrl ? routeForHref(sourceUrl, { title }) : null
  return {
    route: linkRoute?.name === 'prReview' ? linkRoute : {
      name: 'prReview',
      params: {
        number: choice.number,
        title,
        expectedRepo: choice.pullRequest?.baseRepo,
      },
    },
    sourceUrl,
  }
}
