import { normalizeDisplayName, type AccessTokenClaims, type HandshakeCredential, type HostKind } from '@solus/contracts/uplink'
import type { ResolvedLinkShare } from '../sharing/share-manager'
import type { TokenVerdict } from './access-tokens'
import { isDeviceRevoked, verifySessionToken } from './auth'
import { GRANT_DEVICE_LABEL, GUEST_DEVICE_LABEL, type Principal } from './principal'

/**
 * The doors of a Solus server (docs/plans/simplify-auth-and-sync.md §3 rule 4, §4.2):
 * each credential becomes a principal here, directly. A socket presents its one
 * credential in its handshake; an HTTP caller presents a bearer. Nothing is signed
 * and spent in between.
 *
 * - An access token for this server: a person's client token, or another host's token
 *   acting for the person (`act`). Both have this server's audience; the verifier
 *   checked it. `principalForClaims`.
 * - A pairing session token: a device paired on the local network. `pairedPrincipalFor`.
 * - A share secret, with the guest's own id and name. `guestPrincipalFor`.
 *
 * An access token is a bearer credential for its life (ADR 0001): a socket that
 * reconnects presents it again, so it is not spent at admission. The host's own
 * refusal of a device (the Access tab's Revoke) holds at every door.
 */

export type AdmissionRefusal =
  | 'device-revoked'
  /** The Solus API admits a person only as a member of one organization. */
  | 'member-required'
  | 'organization-not-listed'
  | 'no-acting-host'
  | 'token-refused'
  | 'pairing-refused'
  | 'not-shared'
  /** The credential is not one this door takes. */
  | 'not-accepted'

export type Admission =
  /** `actingHostId`: the host that presented a person's token for them (`act`), which is also the principal's device. */
  | { ok: true; principal: Principal; actingHostId?: string }
  | { ok: false; reason: AdmissionRefusal }

/** Where a credential is presented: a host (personal, managed), or the Solus API. */
export type AdmissionPlace = 'host' | 'api'

/**
 * How long one host-admitted guest visit lasts before the page dials again with the
 * secret. A revoked or regenerated link ends the visit at once through the share
 * change, and every call checks the secret's hash again, so this clock only bounds a
 * socket nobody revoked.
 */
export const GUEST_VISIT_TTL_MS = 12 * 60 * 60 * 1000

/**
 * The principal an access token stands for. A person's token admits its owner or a
 * member of the organization the connection names, which the token must list. Another
 * host's token (`act`) admits the person with the standing the account plane stated,
 * with the acting host as the device, so revoking that host on the Access tab holds
 * here too. The Solus API admits only members.
 */
export function principalForClaims(claims: AccessTokenClaims, organizationId: string | undefined, place: AdmissionPlace): Admission {
  const expiresAt = claims.exp * 1000
  const displayName = normalizeDisplayName(claims.displayName) ?? undefined
  const hostKind = claims.hostKind ?? 'personal'
  if (claims.act) {
    const actingHostId = claims.act.host_id
    if (!actingHostId) return { ok: false, reason: 'no-acting-host' }
    if (isDeviceRevoked(actingHostId)) return { ok: false, reason: 'device-revoked' }
    if (claims.access !== 'org-member') {
      if (place === 'api') return { ok: false, reason: 'member-required' }
      if (organizationId) return { ok: false, reason: 'organization-not-listed' }
      return { ok: true, principal: grantOwner(claims.sub, actingHostId, expiresAt, displayName), actingHostId }
    }
    if (organizationId && organizationId !== claims.organizationId) return { ok: false, reason: 'organization-not-listed' }
    return { ok: true, principal: member(claims, { id: claims.organizationId, role: claims.organizationRole, teamIds: claims.teamIds }, actingHostId, hostKind), actingHostId }
  }
  if (isDeviceRevoked(claims.grant_id)) return { ok: false, reason: 'device-revoked' }
  if (claims.access === 'org-member') {
    const listed = claims.organizations?.find((entry) => entry.id === organizationId)
    if (!listed) return { ok: false, reason: 'organization-not-listed' }
    return { ok: true, principal: member(claims, listed, claims.grant_id, hostKind) }
  }
  if (place === 'api') return { ok: false, reason: 'member-required' }
  return { ok: true, principal: grantOwner(claims.sub, claims.grant_id, expiresAt, displayName) }
}

/**
 * A guest of a share link this server made (docs/plans/host-sharing.md §4.1): the
 * secret alone admits them, bound to the one resource it names, with the link's role.
 * The id and name are theirs to state.
 */
export async function guestPrincipalFor(
  resolveShareSecret: (secret: string) => Promise<ResolvedLinkShare | null>,
  secret: string,
  guestId: string,
  displayName: string,
): Promise<Admission> {
  const share = await resolveShareSecret(secret)
  if (!share) return { ok: false, reason: 'not-shared' }
  const bound: Extract<Principal, { kind: 'guest' }>['share'] = { resource: share.resource, role: share.role, sharedByUserId: share.sharedByUserId, linkSecretHash: share.linkSecretHash }
  if (share.actions) bound.actions = share.actions
  return {
    ok: true,
    principal: {
      kind: 'guest',
      organizationId: share.organizationId,
      guestId,
      displayName: normalizeDisplayName(displayName) ?? 'Guest',
      deviceId: guestId,
      share: bound,
      // The transport ends the socket here: at the end of the visit, or when the link expires first.
      expiresAt: Math.min(Date.now() + GUEST_VISIT_TTL_MS, share.expiresAt ?? Number.POSITIVE_INFINITY),
      deviceLabel: GUEST_DEVICE_LABEL,
    },
  }
}

/** A device paired on the local network: the local owner, until the owner revokes it. */
export function pairedPrincipalFor(sessionToken: string): Admission {
  const paired = verifySessionToken(sessionToken)
  if (!paired) return { ok: false, reason: 'pairing-refused' }
  return { ok: true, principal: { kind: 'owner', via: 'local', deviceId: paired.deviceId, deviceLabel: paired.deviceLabel, expiresAt: null } }
}

export interface DoorOptions {
  place: AdmissionPlace
  /** No pairing on a managed host or the Solus API: a session token is no credential there. */
  pairingDisabled?: boolean
  /** Absent on a host that is not linked: access tokens are then no credential here. */
  verifyAccessToken?: (token: string) => Promise<TokenVerdict>
  resolveShareSecret?: (secret: string) => Promise<ResolvedLinkShare | null>
  /** A person's own token was admitted: the server may make its delegations from it (transport wires `sync/delegations.ts`). */
  onPersonToken?: (verdict: Extract<TokenVerdict, { ok: true }>, token: string, organizationId: string | undefined) => void
}

export interface Doors {
  /** A socket's one handshake credential. */
  admitCredential(credential: HandshakeCredential): Promise<Admission>
  /** An HTTP bearer: a pairing session token or an access token, in the organization the request names. */
  admitBearer(bearer: string, organizationId: string | undefined): Promise<Admission>
}

export function createDoors(options: DoorOptions): Doors {
  const pairing = (token: string): Admission => options.pairingDisabled ? { ok: false, reason: 'not-accepted' } : pairedPrincipalFor(token)
  const accessToken = async (token: string, organizationId: string | undefined, fromSocket: boolean): Promise<Admission> => {
    if (!options.verifyAccessToken) return { ok: false, reason: 'not-accepted' }
    const verdict = await options.verifyAccessToken(token)
    if (!verdict.ok) return { ok: false, reason: 'token-refused' }
    // A host acting for a person reaches the Solus API over HTTP and its runner routes, never a socket.
    if (fromSocket && verdict.claims.act && options.place === 'api') return { ok: false, reason: 'not-accepted' }
    const admission = principalForClaims(verdict.claims, organizationId, options.place)
    if (admission.ok && !verdict.claims.act) options.onPersonToken?.(verdict, token, organizationId)
    return admission
  }
  return {
    admitCredential: async (credential) => {
      switch (credential.kind) {
        case 'access-token': return accessToken(credential.token, credential.organizationId, true)
        case 'session-token': return pairing(credential.token)
        case 'share-secret': return options.resolveShareSecret
          ? guestPrincipalFor(options.resolveShareSecret, credential.secret, credential.guestId, credential.displayName)
          : { ok: false, reason: 'not-accepted' }
      }
    },
    admitBearer: async (bearer, organizationId) => {
      if (!bearer || bearer.length > 16_384) return { ok: false, reason: 'not-accepted' }
      // A pairing session token has two segments (`signed-token.ts`); anything else is read as an access token.
      return !options.pairingDisabled && bearer.split('.').length === 2 ? pairedPrincipalFor(bearer) : accessToken(bearer, organizationId, false)
    },
  }
}

function grantOwner(userId: string, deviceId: string, expiresAt: number, displayName: string | undefined): Principal {
  const owner: Extract<Principal, { kind: 'owner'; via: 'grant' }> = { kind: 'owner', via: 'grant', userId, deviceId, expiresAt, deviceLabel: GRANT_DEVICE_LABEL }
  if (displayName) owner.displayName = displayName
  return owner
}

function member(claims: AccessTokenClaims, standing: { id: string; role: 'owner' | 'member'; teamIds: string[] }, deviceId: string, hostKind: HostKind): Principal {
  const principal: Extract<Principal, { kind: 'org-member' }> = {
    kind: 'org-member',
    userId: claims.sub,
    organizationId: standing.id,
    organizationRole: standing.role,
    teamIds: standing.teamIds,
    hostKind,
    displayName: normalizeDisplayName(claims.displayName) ?? 'Member',
    deviceId,
    expiresAt: claims.exp * 1000,
    deviceLabel: GRANT_DEVICE_LABEL,
  }
  if (claims.picture) principal.avatarUrl = claims.picture
  if (claims.email) principal.email = claims.email
  return principal
}
