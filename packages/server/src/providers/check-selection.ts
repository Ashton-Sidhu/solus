import type { CheckItem } from '@solus/contracts/checks-types'

export const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure'])

export function selectChecks(checks: CheckItem[], name?: string): CheckItem[] {
  if (name === undefined) return checks.filter((check) => !check.inFlight && ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? ''))
  const matching = checks.filter((check) => check.name.toLowerCase() === name.trim().toLowerCase())
  if (matching.length === 0) throw new Error(`No check is named ${name}. Checks: ${checks.map(check => check.name).join(", ") || "none"}.`)
  return matching
}
