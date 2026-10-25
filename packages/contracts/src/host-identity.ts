import { ed25519 } from '@noble/curves/ed25519.js'
import { z } from 'zod'

/**
 * A host's identity key (docs/plans/host-routes.md D3): one Ed25519 key pair for
 * each installation, made at the first start and never rotated. A client learns
 * the public half from a source it already trusts: the pairing, the SSH
 * connection that added the host, or the host itself over the first connection
 * through its tunnel. Then, before it sends a credential on an `http:` route, it
 * asks `/health?nonce=` and verifies the host's signature over the nonce.
 *
 * The proof stops another device that answers on the address from taking the
 * credential. It does not encrypt the connection, so a relay between the client
 * and the real host is not stopped. A plain-HTTP pairing has the same limit.
 */

/** The public key as it travels and is saved: 32 bytes, base64url. */
export const hostIdentityKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** What `/health?nonce=` adds: the signature over the nonce and the installation id, base64url. */
export const healthProofSchema = z.object({ signature: z.string().min(1) })
export type HealthProof = z.infer<typeof healthProofSchema>

/** How long a client's nonce is: 16 random bytes, base64url. */
export function newHealthNonce(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)))
}

/** The bytes the host signs: they name this purpose, so a signature made for another use never counts. */
export function hostProofMessage(nonce: string, installationId: string): Uint8Array {
  return new TextEncoder().encode(`solus-host-proof:v1\n${nonce}\n${installationId}`)
}

/** Whether `proof` is the host's signature over `nonce` for `installationId`. Never throws. */
export function verifyHostProof(identityKey: string, nonce: string, installationId: string, proof: HealthProof): boolean {
  try {
    return ed25519.verify(fromBase64Url(proof.signature), hostProofMessage(nonce, installationId), fromBase64Url(identityKey))
  } catch {
    return false
  }
}

/**
 * Whether a dial on `url` must first prove the host. An `https:` route has TLS to a
 * name the host or Solus cloud controls. The page's own origin served the code
 * that is running, so it is trusted as far as the page is.
 */
export function routeNeedsProof(route: { url: string; source?: string }): boolean {
  return route.url.startsWith('http:') && route.source !== 'page'
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
