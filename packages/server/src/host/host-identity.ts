import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { hostProofMessage, toBase64Url, type HealthProof } from '@solus/contracts/host-identity'
import { createLogger } from '../logger'
import { solusDir } from '../platform/paths'

const log = createLogger('main', 'host-identity')

/**
 * This installation's identity key (docs/plans/host-routes.md D3): an Ed25519 key
 * pair made at the first start and never rotated. It lives beside the installation
 * id (`server-keys.json`), because the two name the same host: a new installation id
 * comes with a new key. A client verifies `proveTo` with the public half before it
 * sends a credential on an `http:` route.
 */
export interface HostIdentity {
  /** The public key, 32 bytes base64url. */
  publicKey(): string
  /** The signature that proves this host to a client that sent `nonce`. */
  proveTo(nonce: string, installationId: string): HealthProof
}

const IDENTITY_FILE = 'host-identity.json'
const storedIdentitySchema = z.object({ privateKeyPem: z.string().min(1) })

export function loadHostIdentity(dir: string = solusDir()): HostIdentity {
  const privateKey = loadOrCreatePrivateKey(dir)
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' })
  if (!publicJwk.x) throw new Error('The host identity key has no public part.')
  const publicKey = publicJwk.x
  return {
    publicKey: () => publicKey,
    proveTo: (nonce, installationId) => ({ signature: toBase64Url(sign(null, hostProofMessage(nonce, installationId), privateKey)) }),
  }
}

function loadOrCreatePrivateKey(dir: string): KeyObject {
  const file = join(dir, IDENTITY_FILE)
  if (existsSync(file)) {
    try {
      const stored = storedIdentitySchema.parse(JSON.parse(readFileSync(file, 'utf-8')))
      return createPrivateKey(stored.privateKeyPem)
    } catch (error) {
      // A new key makes every client that saved the old one refuse this host until it pairs again.
      log.warn('host_identity_unreadable', { file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const { privateKey } = generateKeyPairSync('ed25519')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify({ privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) }, null, 2), { mode: 0o600 })
  log.info('host_identity_created', {})
  return privateKey
}

let current: HostIdentity | null = null

/** This process's identity, loaded once. */
export function hostIdentity(): HostIdentity {
  current ??= loadHostIdentity()
  return current
}
