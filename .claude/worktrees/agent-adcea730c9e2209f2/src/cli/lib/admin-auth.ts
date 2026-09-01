import { createHmac, randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

interface ServerKeysFile {
  signingKey?: unknown
}

export interface AdminHeaders {
  'x-solus-admin-timestamp': string
  'x-solus-admin-nonce': string
  'x-solus-admin-signature': string
}

export function readSigningKey(dataDir: string): string | null {
  const file = join(dataDir, 'server-keys.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ServerKeysFile
    return typeof parsed.signingKey === 'string' && parsed.signingKey ? parsed.signingKey : null
  } catch {
    return null
  }
}

export function createAdminHeaders(signingKey: string, now = Date.now(), nonce = randomBytes(12).toString('hex')): AdminHeaders {
  const timestamp = String(now)
  const signature = createHmac('sha256', signingKey).update(`claim-open:${timestamp}:${nonce}`).digest('hex')
  return {
    'x-solus-admin-timestamp': timestamp,
    'x-solus-admin-nonce': nonce,
    'x-solus-admin-signature': signature,
  }
}
