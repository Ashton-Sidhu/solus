/** A launch-only bypass for agents testing a fresh client. */
export function skipsOnboarding(search: string): boolean {
  return new URLSearchParams(search).has('skip-onboarding')
}
