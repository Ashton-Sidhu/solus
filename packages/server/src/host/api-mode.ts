import { SOLUS_API_CLIENT_ID, tokenEndpoint } from '@solus/contracts/uplink'
import { createLogger } from '../logger'
import { clientCredential, privateJwkSchema, type HostCredential } from './host-credential'

const log = createLogger('main', 'api-mode')

/**
 * API mode (docs/plans/cloud-service-model.md §15): how the server boots as
 * an organization's workspace service in the cloud. The process learns it from its
 * environment once, and it holds for the life of the process: there is no link
 * record and no tunnel connector, pairing does not exist, nobody is trusted by
 * network position, every caller presents a grant minted for `SOLUS_API_AUDIENCE`,
 * and the only plane served is `collaboration`.
 *
 * `SOLUS_API=1` turns it on. `SOLUS_CLOUD_ISSUER` and `SOLUS_CLOUD_JWKS_URL`
 * name the one issuer whose grants are admitted. `DATABASE_URL` is required: one
 * Postgres serves every organization. A test that says `SOLUS_DB=sqlite`
 * explicitly may run the service on a file instead.
 */

export interface ApiModeConfig {
  issuer: string
  jwksUrl: string
}

interface ApiModeEnv {
  SOLUS_API?: string
  SOLUS_CLOUD_ISSUER?: string
  SOLUS_CLOUD_JWKS_URL?: string
  SOLUS_API_CLIENT_KEY?: string
  DATABASE_URL?: string
  SOLUS_DB?: string
}

let workspace: boolean | undefined
let config: ApiModeConfig | undefined
let credential: HostCredential | null | undefined

export function isApiMode(env: ApiModeEnv = process.env): boolean {
  if (workspace === undefined) workspace = env.SOLUS_API === '1'
  return workspace
}

function readApiModeConfig(env: ApiModeEnv): ApiModeConfig {
  const issuer = env.SOLUS_CLOUD_ISSUER?.trim()
  const jwksUrl = env.SOLUS_CLOUD_JWKS_URL?.trim()
  if (!issuer || !jwksUrl) throw new Error('API mode needs SOLUS_CLOUD_ISSUER and SOLUS_CLOUD_JWKS_URL.')
  return { issuer, jwksUrl }
}

/** The issuer the service trusts, read once from the process environment. Throws outside API mode, or when the environment names none. */
export function apiModeConfig(): ApiModeConfig {
  if (config) return config
  if (!isApiMode()) throw new Error('Not in API mode.')
  config = readApiModeConfig(process.env)
  return config
}

/**
 * The Solus API's service credential (docs/adr/0001-standard-authentication.md §6.2):
 * `SOLUS_API_CLIENT_KEY`, a private ES256 JWK on P-256, with which it exchanges a
 * person's API token for a delegated token for the account plane, as the `solus-api`
 * client. Read once and taken out of the environment, so no process this one starts
 * inherits it. Null when it is not set: the Solus API then reads nobody's account.
 * A value that is not such a key fails here.
 */
export function apiModeCredential(env: ApiModeEnv = process.env): HostCredential | null {
  if (credential !== undefined) return credential
  const raw = env.SOLUS_API_CLIENT_KEY?.trim()
  delete env.SOLUS_API_CLIENT_KEY
  if (!raw) return (credential = null)
  let parsed: ReturnType<typeof privateJwkSchema.safeParse>
  try {
    parsed = privateJwkSchema.safeParse(JSON.parse(raw))
  } catch {
    throw new Error('SOLUS_API_CLIENT_KEY must be a private ES256 JWK on P-256.')
  }
  if (!parsed.success) throw new Error('SOLUS_API_CLIENT_KEY must be a private ES256 JWK on P-256.')
  credential = clientCredential({ clientId: SOLUS_API_CLIENT_ID, privateJwk: parsed.data, tokenEndpoint: tokenEndpoint(apiModeConfig().issuer) })
  return credential
}

/**
 * Process-wide consequences of API mode, applied before anything else at
 * boot: the configuration is read and refused when incomplete, so a misconfigured
 * service fails at start rather than admitting nobody.
 */
export function applyApiMode(env: ApiModeEnv = process.env): void {
  if (env.SOLUS_API !== '1') return
  const { issuer } = readApiModeConfig(env)
  if (!env.DATABASE_URL?.trim() && env.SOLUS_DB?.trim().toLowerCase() !== 'sqlite') {
    throw new Error('API mode needs DATABASE_URL (or an explicit SOLUS_DB=sqlite for a test).')
  }
  log.info('api_mode_applied', { issuer, engine: env.DATABASE_URL?.trim() ? 'postgres' : 'sqlite' })
}

/** Tests only: forget the cached environment so the next read sees the test's. */
export function resetApiModeForTests(): void {
  workspace = undefined
  config = undefined
  credential = undefined
}
