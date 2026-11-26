import { normalizeCheckCode } from '@solus/contracts/add-machine'
import type { AppSignInRequest } from '@solus/contracts/host-api'
import { parseAppSignInLink } from '@solus/contracts/outside-apps'
import { OUTSIDE_APP_ACCESS_LEVELS, type OutsideAppAccessLevel } from './outside-apps'

/**
 * "Approve a sign-in" in "Use Solus in other apps" (plans/035 §0.5): an app's
 * sign-in page waits, with a check code and a QR code of its
 * `solus://approve-app` link, until a person approves it in their own Solus
 * client. The app then acts as that person.
 */

/** A sign-in that a link names: the host's installation id and the request on it. */
export interface AppSignInLinkTarget {
  hostId: string
  requestId: string
}

/** What the person typed or pasted: the check code from the sign-in page, its link, or neither. */
export type AppSignInInput =
  | { kind: 'code'; checkCode: string }
  | { kind: 'link'; target: AppSignInLinkTarget }
  | { kind: 'invalid' }

export function appSignInInput(value: string): AppSignInInput {
  const target = parseAppSignInLink(value.trim())
  if (target) return { kind: 'link', target }
  const checkCode = normalizeCheckCode(value)
  return checkCode ? { kind: 'code', checkCode } : { kind: 'invalid' }
}

/**
 * The web client's form of the link: `?approveApp=<requestId>&host=<hostId>`
 * on the page's address. A browser cannot take `solus://`.
 */
export const APPROVE_APP_PARAM = 'approveApp'
export const APPROVE_APP_HOST_PARAM = 'host'

/** The sign-in that a page's query names, or null. */
export function appSignInFromSearch(search: string): AppSignInLinkTarget | null {
  const params = new URLSearchParams(search)
  const requestId = params.get(APPROVE_APP_PARAM)
  const hostId = params.get(APPROVE_APP_HOST_PARAM)
  return requestId && hostId ? { hostId, requestId } : null
}

/** The page's query without that link, so a reload does not open it again. */
export function searchWithoutAppSignIn(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(APPROVE_APP_PARAM)
  params.delete(APPROVE_APP_HOST_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}

/** The text when a link names a host that this client has no connection to. */
export const UNKNOWN_HOST_TEXT = 'This sign-in is for a host this device is not connected to.'

/** The client's host for the installation id in a link, or null. A host is known by its id or its installation id. */
export function serverIdForAppSignIn(hostId: string, servers: readonly { id: string; installationId?: string }[]): string | null {
  return servers.find((server) => server.id === hostId || server.installationId === hostId)?.id ?? null
}

/** "Access goes to {place}", and which computer when the sign-in returns to the one that opened its page. */
export function appSignInPlaceText(request: Pick<AppSignInRequest, 'redirectPlace' | 'onThisComputer'>): string {
  return request.onThisComputer
    ? `Access goes to ${request.redirectPlace} on the computer that opened the sign-in page.`
    : `Access goes to ${request.redirectPlace}.`
}

/** The access level of the request, with what it lets the app do. */
export function appSignInAccess(request: Pick<AppSignInRequest, 'access'>): OutsideAppAccessLevel {
  return OUTSIDE_APP_ACCESS_LEVELS.find((level) => level.access === request.access) ?? OUTSIDE_APP_ACCESS_LEVELS[0]
}

/** "Expires in 4:59". Null once the sign-in expired. */
export function appSignInTimeLeft(expiresAt: number, now: number): string | null {
  const msLeft = expiresAt - now
  if (msLeft <= 0) return null
  const totalSeconds = Math.ceil(msLeft / 1000)
  const seconds = totalSeconds % 60
  return `Expires in ${Math.floor(totalSeconds / 60)}:${seconds.toString().padStart(2, '0')}`
}

export type AppSignInDecision = 'approve' | 'deny'

/** The done state after a decision. */
export function appSignInDoneText(appName: string, decision: AppSignInDecision): string {
  return decision === 'approve' ? `Approved. Go back to ${appName}.` : `Denied. ${appName} gets no access.`
}

/**
 * A refused read or decision in plain words. The host's reason shows only when
 * it is none of the known ones.
 */
export function appSignInErrorText(message: string, phase: 'read' | AppSignInDecision): string {
  if (/unknown method/i.test(message)) return 'This host cannot approve sign-ins in Solus. Use a pairing code on the sign-in page.'
  if (/expired/i.test(message)) return 'This sign-in expired. Start the sign-in in the app again.'
  if (/already|decided/i.test(message)) return 'This sign-in was already approved or denied.'
  if (/not allowed|forbidden|permission/i.test(message)) return 'You cannot approve app sign-ins on this host.'
  if (/not found|no sign-in|unknown|no such/i.test(message)) {
    return phase === 'read'
      ? 'No sign-in waits for this code. Check the code on the app\'s sign-in page.'
      : 'This sign-in no longer waits. Start the sign-in in the app again.'
  }
  const action = phase === 'read' ? 'read the sign-in' : phase === 'approve' ? 'approve the sign-in' : 'deny the sign-in'
  return `Could not ${action}: ${message}`
}
