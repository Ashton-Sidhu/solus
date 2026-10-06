import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DatabaseEngine } from './engine'

/** Resolve existing ancestors too: a fixture symlink must not lead into live data. */
function canonicalPath(path: string): string {
  const absolutePath = resolve(path)
  if (existsSync(absolutePath)) return realpathSync(absolutePath)
  return join(canonicalPath(dirname(absolutePath)), basename(absolutePath))
}

/** Check before opening a connection or running any migrations. */
export function assertTestDatabase(engine: DatabaseEngine): void {
  if (process.env.SOLUS_TEST_DATABASES !== '1' && process.env.SOLUS_TEST_MODE !== '1' && process.env.NODE_ENV !== 'test') return

  if (engine.kind === 'postgres') {
    const allowedUrl = process.env.SOLUS_TEST_DATABASE_URL
    if (engine.url !== allowedUrl || !/^\/solus_test_[a-z0-9_]+$/.test(new URL(engine.url).pathname)) {
      throw new Error('Tests may only open the Postgres database created by scripts/test-unit.ts.')
    }
    return
  }

  const temporaryRoot = realpathSync(tmpdir())
  const databasePath = canonicalPath(engine.path)
  const fromTemporaryRoot = relative(temporaryRoot, databasePath)
  if (!fromTemporaryRoot || fromTemporaryRoot === '..' || fromTemporaryRoot.startsWith(`..${sep}`) || isAbsolute(fromTemporaryRoot)) {
    throw new Error('Tests may only open SQLite databases in the temporary directory. Set SOLUS_DATA_DIR to a test fixture directory.')
  }
}
