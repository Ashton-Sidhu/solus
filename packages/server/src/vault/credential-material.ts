import { z } from 'zod'
import type { CredentialMaterial, VaultProvider } from '../server/uplink/runner-protocol'

/**
 * What can be read off a credential's material without a database or a key:
 * shared by the vault on the service and the seat manager on a runner.
 */

const claudeCredentialsSchema = z.object({ claudeAiOauth: z.object({ expiresAt: z.number() }).partial() }).partial()
const codexAuthSchema = z.object({ tokens: z.object({ access_token: z.string() }).partial() }).partial()
const jwtPayloadSchema = z.object({ exp: z.number() }).partial()

function parseJson<T>(schema: z.ZodType<T>, text: string | undefined): T | null {
  if (!text) return null
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The `exp` of a JWT, in milliseconds, or null when it carries none that reads. */
function jwtExpiryMs(token: string | undefined): number | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  const claims = parseJson(jwtPayloadSchema, Buffer.from(payload, 'base64url').toString('utf8'))
  const exp = claims?.exp
  return exp === undefined ? null : exp * 1000
}

/**
 * When the access token in the material expires, if it says: Claude's
 * `.credentials.json` carries `claudeAiOauth.expiresAt` in milliseconds; Codex's
 * `auth.json` carries a JWT whose `exp` is in seconds. A pasted Claude token says
 * nothing.
 */
/** The shape `claude auth login` writes to `.credentials.json`; anything else is not a credential set. */
const claudeCredentialSetSchema = z.object({ claudeAiOauth: z.object({ accessToken: z.string().min(1) }).loose() }).loose()

/**
 * Pasted text that is a whole Claude credential set (the contents of
 * `.credentials.json` from a machine where the person ran `claude auth login`)
 * rather than a `setup-token`: stored as a `login` credential, which the usage
 * meter can read. Null for a bare token or anything else.
 */
export function parseClaudeCredentialSet(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = claudeCredentialSetSchema.safeParse(JSON.parse(trimmed))
    return parsed.success ? `${JSON.stringify(parsed.data)}\n` : null
  } catch {
    return null
  }
}

export function credentialExpiresAt(provider: VaultProvider, material: CredentialMaterial): number | null {
  switch (provider) {
    case 'claude-code': {
      const parsed = parseJson(claudeCredentialsSchema, material.files?.['.credentials.json'])
      return parsed?.claudeAiOauth?.expiresAt ?? null
    }
    case 'codex': {
      const parsed = parseJson(codexAuthSchema, material.files?.['auth.json'])
      return jwtExpiryMs(parsed?.tokens?.access_token)
    }
    // Google and Atlassian store `expiresAt` in milliseconds in their own JSON; a GitHub token does not expire.
    case 'google':
    case 'atlassian':
      return parseJson(expiringCredentialSchema, material.files?.[PROVIDER_CREDENTIAL_FILE])?.expiresAt ?? null
    case 'github':
      return null
  }
}

/** The one file a person's GitHub, Google, or Atlassian connection is stored as in the vault (§22). */
export const PROVIDER_CREDENTIAL_FILE = 'credential.json'
const expiringCredentialSchema = z.object({ expiresAt: z.number() }).partial()
