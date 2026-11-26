import { OUTSIDE_APP_IDS, type OutsideAppId } from '@solus/contracts/outside-apps'
import type { PolicyDocument } from '@solus/contracts/policy'

/**
 * The editor's Outside apps choice (`sessions.limits.apps`, plans/035 §10):
 * every app while the key is not set, else the apps it names.
 */

/** The apps a document allows; null when it names none, so every app is allowed. */
export function allowedOutsideApps(document: PolicyDocument): readonly OutsideAppId[] | null {
  return document.sessions?.limits?.apps?.allowed ?? null
}

/**
 * The document with `allowed` as its outside apps, in the order of
 * `OUTSIDE_APP_IDS`. Null, or an empty list, removes the key, and the
 * `limits` and `sessions` objects it leaves empty, so every app is allowed.
 */
export function withAllowedOutsideApps(document: PolicyDocument, allowed: readonly OutsideAppId[] | null): PolicyDocument {
  const [first, ...others] = OUTSIDE_APP_IDS.filter((app) => allowed?.includes(app))
  const { apps: _apps, ...otherLimits } = document.sessions?.limits ?? {}
  const appsAllowed: [OutsideAppId, ...OutsideAppId[]] | null = first ? [first, ...others] : null
  const limits = appsAllowed ? { ...otherLimits, apps: { allowed: appsAllowed } } : otherLimits
  const { limits: _limits, ...otherSessions } = document.sessions ?? {}
  const sessions = Object.keys(limits).length > 0 ? { ...otherSessions, limits } : otherSessions
  const { sessions: _sessions, ...otherFields } = document
  return Object.keys(sessions).length > 0 ? { ...otherFields, sessions } : otherFields
}

/** The choice after the person turns one app on or off. The last app stays on: a policy cannot allow no app. */
export function toggledOutsideApp(allowed: readonly OutsideAppId[], app: OutsideAppId, on: boolean): readonly OutsideAppId[] {
  if (on) return allowed.includes(app) ? allowed : [...allowed, app]
  const next = allowed.filter((entry) => entry !== app)
  return next.length > 0 ? next : allowed
}
