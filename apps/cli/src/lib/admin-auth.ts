import { createHmac, randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'

const serverKeysFileSchema = z.object({ signingKey: z.string().min(1) })

export interface AdminHeaders {
  'x-solus-admin-timestamp': string
  'x-solus-admin-nonce': string
  'x-solus-admin-signature': string
}

export function readSigningKey(dataDir: string): string | null {
  const file = join(dataDir, 'server-keys.json')
  if (!existsSync(file)) return null
  try {
    const parsed = serverKeysFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf-8')))
    return parsed.success ? parsed.data.signingKey : null
  } catch {
    return null
  }
}

export function createAdminHeaders(signingKey: string, now = Date.now(), nonce = randomBytes(12).toString('hex')): AdminHeaders {
  const timestamp = String(now)
  const signature = createHmac('sha256', signingKey).update(`pair-open:${timestamp}:${nonce}`).digest('hex')
  return {
    'x-solus-admin-timestamp': timestamp,
    'x-solus-admin-nonce': nonce,
    'x-solus-admin-signature': signature,
  }
}
