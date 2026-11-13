import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from './test-db'
import { FakeTaskProviders } from './task-fixtures'

/**
 * One host for a task test: a temporary data directory with an empty
 * database, and GitHub and Jira replaced by `FakeTaskProviders`. A task
 * source belongs to no project: a test names the sources it reads. The test
 * file mocks `node:sqlite`
 * before it calls `openTaskTestHost`, as each database test does.
 */
export async function openTaskTestHost(name: string) {
  const previousDataDir = process.env.SOLUS_DATA_DIR
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), `solus-${name}-`)))
  process.env.SOLUS_DATA_DIR = dataDir
  // Imported after the data directory is set: the server modules read it when they load.
  const [db, registry, sources, identity] = await Promise.all([
    import('@solus/server/db'),
    import('@solus/server/data/tasks/providers/registry'),
    import('@solus/server/data/tasks/task-sources'),
    import('@solus/server/execution/seats/acting-identity'),
  ])
  // A process needs to know whose work it is.
  identity.actAsHostForTests()
  let providers = new FakeTaskProviders()
  registry.useTaskAdaptersForTests(providers.adapters())

  return {
    dataDir,
    get providers() {
      return providers
    },
    /** An empty database and new fake providers for the next test. */
    async reset(): Promise<void> {
      sources.resetTaskSourcesForTests()
      await resetTestDatabase()
      for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
      providers = new FakeTaskProviders()
      registry.useTaskAdaptersForTests(providers.adapters())
    },
    close(): void {
      registry.useTaskAdaptersForTests(null)
      db.closeDb()
      rmSync(dataDir, { recursive: true, force: true })
      if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
      else process.env.SOLUS_DATA_DIR = previousDataDir
    },
  }
}
