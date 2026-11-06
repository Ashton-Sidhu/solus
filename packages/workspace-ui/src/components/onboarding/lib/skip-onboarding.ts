declare global {
  interface Window {
    /** Set by Solus in every page of its browser (server `guest-mark.ts`). */
    __solusBrowserGuest?: boolean
  }
}

/**
 * Whether this client opens without onboarding.
 *
 * A launch flag skips it for one load. A page in the Solus browser always skips
 * it: an agent checks a route there, and the first-run flow would cover that
 * route on every load. `?show-onboarding` shows it there, to check the flow.
 */
export function skipsOnboarding(search: string, page: Pick<Window, '__solusBrowserGuest'>): boolean {
  const params = new URLSearchParams(search)
  if (params.has('skip-onboarding')) return true
  return page.__solusBrowserGuest === true && !params.has('show-onboarding')
}
