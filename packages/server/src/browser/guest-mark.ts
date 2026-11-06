/**
 * Tells a page that it runs in the Solus browser, before its own scripts run.
 *
 * The Solus client reads this to open a route without onboarding, so no agent
 * has to know about the flow (`skip-onboarding.ts`). Assigning twice is harmless:
 * a host installs this on new documents and may also run it on the current one.
 */
export const BROWSER_GUEST_MARK_SCRIPT = 'window.__solusBrowserGuest = true'
