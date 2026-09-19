import { z } from 'zod'
import { join } from 'path'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import type { TypeSafeKeyStatus } from '@solus/contracts/host-config'

const keySchema = z.object({ apiKey: z.string().trim().min(1).max(4096) })
let saved: { apiKey: string } | null | undefined

function savedKey(): string | undefined {
  if (saved === undefined) {
    saved = secretStore().loadJson('typesafe', join(dataDir(), 'typesafe.enc'), keySchema)
  }
  return saved?.apiKey
}

export function typeSafeApiKey(): string | undefined {
  return savedKey() ?? (process.env.TYPESAFE_API_KEY?.trim() || undefined)
}

export function typeSafeKeyStatus(): TypeSafeKeyStatus {
  return { source: savedKey() ? 'saved' : typeSafeApiKey() ? 'environment' : null }
}

/** Null removes only the saved key. Never return credentials to a client. */
export function setTypeSafeApiKey(apiKey: string | null): void {
  const value = apiKey === null ? null : keySchema.parse({ apiKey })
  const path = join(dataDir(), 'typesafe.enc')
  if (value) secretStore().saveJson('typesafe', path, value)
  else secretStore().remove('typesafe', path)
  saved = value
}
