import { join } from 'node:path'
import { solusDir } from '../platform/paths'

/**
 * Which database engine this process runs on (docs/plans/cloud-service-model.md).
 * Chosen once at boot from the environment: a host runs SQLite in its data
 * directory with no configuration, the cloud runs one Postgres for every
 * instance. `SOLUS_DB` is the explicit choice; `DATABASE_URL` alone means
 * Postgres; nothing means SQLite.
 */
export type DatabaseEngine =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string }

export interface EngineEnv {
  SOLUS_DB?: string
  DATABASE_URL?: string
}

export function resolveEngine(env: EngineEnv = process.env): DatabaseEngine {
  const choice = env.SOLUS_DB?.trim().toLowerCase()
  if (choice && choice !== 'sqlite' && choice !== 'postgres') {
    throw new Error(`SOLUS_DB must be "sqlite" or "postgres", not "${env.SOLUS_DB}".`)
  }
  const url = env.DATABASE_URL?.trim()
  if (choice === 'postgres' || (!choice && url)) {
    if (!url) throw new Error('SOLUS_DB=postgres needs DATABASE_URL.')
    return { kind: 'postgres', url }
  }
  return { kind: 'sqlite', path: join(solusDir(), 'solus.db') }
}
