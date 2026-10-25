import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHostIdentity, type HostIdentity } from '@solus/server/host/host-identity'

/**
 * A fake host that proves itself as a real one does (docs/plans/host-routes.md D3):
 * a client sends a credential on an `http:` route only after the host signs its
 * `/health?nonce=` with the identity key the client saved. Each installation id
 * gets one real Ed25519 key for the test process, so a saved host's `identityKey`
 * and the fake host's `/health` agree, and a device that answers as another
 * installation signs with another key.
 */
const identities = new Map<string, HostIdentity>()

/** The signing key of the fake host with `installationId`, made once per test process. */
export function hostIdentityFor(installationId: string): HostIdentity {
  let identity = identities.get(installationId)
  if (!identity) {
    identity = loadHostIdentity(mkdtempSync(join(tmpdir(), 'solus-test-identity-')))
    identities.set(installationId, identity)
  }
  return identity
}

/** The public key a client saves for the fake host with `installationId`. */
export function identityKeyFor(installationId: string): string {
  return hostIdentityFor(installationId).publicKey()
}

/** The `/health` body the fake host with `installationId` gives a read of `input`: with a proof when the read sent a nonce. */
export function signedHealth(input: string | URL | Request, installationId: string, extra: object = {}): object {
  const nonce = new URL(input instanceof Request ? input.url : String(input)).searchParams.get('nonce')
  return { ok: true, installationId, ...extra, ...(nonce ? { proof: hostIdentityFor(installationId).proveTo(nonce, installationId) } : {}) }
}

/** The base url of a `/health` read, with or without a nonce. */
export function healthBase(input: string | URL | Request): string | null {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.pathname !== '/health' && !url.pathname.endsWith('/health')) return null
  return `${url.origin}${url.pathname.replace(/\/health$/, '')}`
}
