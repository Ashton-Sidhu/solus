import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { z } from 'zod'
import { dataDir } from '../platform/paths'

/**
 * HMAC capabilities for URLs a client uses without a bearer token: signed asset
 * reads and streamed attachment uploads. A leaf, so the asset and attachment
 * modules can both sign without importing each other.
 *
 * The signature proves only that this host minted the payload. Each caller
 * parses the payload with its own strict schema, and the schemas do not
 * overlap, so a token minted for one purpose cannot be spent on the other.
 */

let cachedSecret: { path: string; value: Buffer } | null = null

/** One random asset-capability secret per host data directory. */
export function getAssetSigningSecret(): Buffer {
  const stateDir = join(dataDir(), 'state')
  const secretPath = join(stateDir, 'asset-signing-secret')
  if (cachedSecret?.path === secretPath) return cachedSecret.value
  mkdirSync(stateDir, { recursive: true })

  let value: Buffer
  if (existsSync(secretPath)) {
    value = Buffer.from(readFileSync(secretPath, 'utf8').trim(), 'hex')
  } else {
    value = randomBytes(32)
    try {
      writeFileSync(secretPath, value.toString('hex'), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      value = Buffer.from(readFileSync(secretPath, 'utf8').trim(), 'hex')
    }
  }
  if (value.length !== 32) throw new Error('The host asset signing secret is invalid.')
  cachedSecret = { path: secretPath, value }
  return value
}

export function signToken<T>(payload: T, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

/** The payload of a token this host signed, parsed by the caller's schema, or
 *  null when the signature or the shape is wrong. */
export function readSignedToken<T>(token: string, secret: Buffer, schema: z.ZodType<T>): T | null {
  const separator = token.lastIndexOf('.')
  if (separator <= 0 || separator === token.length - 1) return null
  const encoded = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expected = createHmac('sha256', secret).update(encoded).digest()
  let received: Buffer
  try {
    received = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
  try {
    const result = schema.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
