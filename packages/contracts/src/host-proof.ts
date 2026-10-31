import { ed25519 } from '@noble/curves/ed25519.js'
import { fromBase64Url, hostProofMessage, type HealthProof } from './host-identity'

// Apart from host-identity: the Ed25519 code is about 100 KB, and a web client
// needs it only to dial an `http:` route (`routeNeedsProof`), so it loads it then.

/** Whether `proof` is the host's signature over `nonce` for `installationId`. Never throws. */
export function verifyHostProof(identityKey: string, nonce: string, installationId: string, proof: HealthProof): boolean {
  try {
    return ed25519.verify(fromBase64Url(proof.signature), hostProofMessage(nonce, installationId), fromBase64Url(identityKey))
  } catch {
    return false
  }
}
