import { createLogger } from '../logger'

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
  DATABASE_URL?: string
  SOLUS_DB?: string
}

let workspace: boolean | undefined
let config: ApiModeConfig | undefined

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
}
