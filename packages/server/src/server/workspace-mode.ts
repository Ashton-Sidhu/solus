import { createLogger } from '../logger'

const log = createLogger('main', 'workspace-mode')

/**
 * Workspace mode (docs/plans/cloud-service-model.md §15): how the server boots as
 * an organization's workspace service in the cloud. The process learns it from its
 * environment once, and it holds for the life of the process: there is no link
 * record and no tunnel connector, pairing does not exist, nobody is trusted by
 * network position, every caller presents a grant minted for `WORKSPACE_AUDIENCE`,
 * and the only plane served is `collaboration`.
 *
 * `SOLUS_WORKSPACE=1` turns it on. `SOLUS_CLOUD_ISSUER` and `SOLUS_CLOUD_JWKS_URL`
 * name the one issuer whose grants are admitted. `DATABASE_URL` is required: one
 * Postgres serves every organization. A test that says `SOLUS_DB=sqlite`
 * explicitly may run the service on a file instead.
 */

export interface WorkspaceConfig {
  issuer: string
  jwksUrl: string
}

interface WorkspaceEnv {
  SOLUS_WORKSPACE?: string
  SOLUS_CLOUD_ISSUER?: string
  SOLUS_CLOUD_JWKS_URL?: string
  DATABASE_URL?: string
  SOLUS_DB?: string
}

let workspace: boolean | undefined
let config: WorkspaceConfig | undefined

export function isWorkspaceMode(env: WorkspaceEnv = process.env): boolean {
  if (workspace === undefined) workspace = env.SOLUS_WORKSPACE === '1'
  return workspace
}

function readWorkspaceConfig(env: WorkspaceEnv): WorkspaceConfig {
  const issuer = env.SOLUS_CLOUD_ISSUER?.trim()
  const jwksUrl = env.SOLUS_CLOUD_JWKS_URL?.trim()
  if (!issuer || !jwksUrl) throw new Error('Workspace mode needs SOLUS_CLOUD_ISSUER and SOLUS_CLOUD_JWKS_URL.')
  return { issuer, jwksUrl }
}

/** The issuer the service trusts, read once from the process environment. Throws outside workspace mode, or when the environment names none. */
export function workspaceConfig(): WorkspaceConfig {
  if (config) return config
  if (!isWorkspaceMode()) throw new Error('Not in workspace mode.')
  config = readWorkspaceConfig(process.env)
  return config
}

/**
 * Process-wide consequences of workspace mode, applied before anything else at
 * boot: the configuration is read and refused when incomplete, so a misconfigured
 * service fails at start rather than admitting nobody.
 */
export function applyWorkspaceMode(env: WorkspaceEnv = process.env): void {
  if (env.SOLUS_WORKSPACE !== '1') return
  const { issuer } = readWorkspaceConfig(env)
  if (!env.DATABASE_URL?.trim() && env.SOLUS_DB?.trim().toLowerCase() !== 'sqlite') {
    throw new Error('Workspace mode needs DATABASE_URL (or an explicit SOLUS_DB=sqlite for a test).')
  }
  log.info('workspace_mode_applied', { issuer, engine: env.DATABASE_URL?.trim() ? 'postgres' : 'sqlite' })
}

/** Tests only: forget the cached environment so the next read sees the test's. */
export function resetWorkspaceModeForTests(): void {
  workspace = undefined
  config = undefined
}
