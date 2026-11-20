import { z } from 'zod'
import { linearRefSchema, typesafeRefSchema } from './vault'

/** Key connections that the host can keep for its user before account sign-in. */
export const vaultKeyRefSchema = z.union([linearRefSchema, typesafeRefSchema])
export type VaultKeyRef = z.infer<typeof vaultKeyRefSchema>
export const vaultKeySaveSchema = z.object({
  ref: vaultKeyRefSchema,
  key: z.string().trim().min(1).max(4096)
}).strict()
export type VaultKeySave = z.infer<typeof vaultKeySaveSchema>

/** Account credentials are managed by the client through the account vault. */
export type VaultKeyStatus =
  | { kind: 'host'; connected: boolean }
  | { kind: 'account' }
  | { kind: 'unavailable' }
