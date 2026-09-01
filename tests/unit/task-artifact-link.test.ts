import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type TaskStoreModule = typeof import('@solus/server/tasks/task-store')
type TaskModule = typeof import('@solus/server/tasks/task')
type LineageModule = typeof import('@solus/server/sessions/session-lineage')

let dataDir: string
let db: DbModule
let taskStore: TaskStoreModule
let tasks: TaskModule
let lineage: LineageModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-task-artifact-link-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  taskStore = await import('@solus/server/tasks/task-store')
  tasks = await import('@solus/server/tasks/task')
  lineage = await import('@solus/server/sessions/session-lineage')
})

afterEach(() => {
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const SOLUS_SESSION_ID = '70e3ce43-65f7-4210-bb1c-3057f96ee2d8'
const PROVIDER_SESSION_ID = '97791a59-b0ec-4370-ac1f-9098c8b7f518'

describe('artifact linking across the session id boundary', () => {
  test('a work created with the provider thread id reaches the task keyed on the Solus id', async () => {
    // WHY: agent tools carry the provider thread id, while the attempt row is
    // keyed on the stable Solus id. Without lineage resolution the lookup finds
    // nothing, the link is skipped without an error, and the created work never
    // appears on the task that produced it.
    const record = await taskStore.createTask({ title: 'Drive integration' })
    const task = await tasks.Task.byId(record.id)
    await task.linkSession(SOLUS_SESSION_ID)
    lineage.registerSessionLineage({
      sessionId: SOLUS_SESSION_ID,
      provider: 'claude-code',
      providerSessionId: PROVIDER_SESSION_ID,
      cwd: '/repo',
    })

    const details = await tasks.Task.linkArtifactForSession(PROVIDER_SESSION_ID, {
      kind: 'work',
      targetKey: 'work-613e21e7',
      title: 'Plan: Drive integration',
    })

    expect(details?.links).toContainEqual(
      expect.objectContaining({ kind: 'work', targetKey: 'work-613e21e7' }),
    )
  })

  test('the stable Solus id still resolves its own task', async () => {
    // WHY: the renderer and ControlPlane already pass the stable id. Resolving
    // the provider alias must not cost them their direct match.
    const record = await taskStore.createTask({ title: 'Drive integration' })
    const task = await tasks.Task.byId(record.id)
    await task.linkSession(SOLUS_SESSION_ID)

    const resolved = await tasks.Task.forSession(SOLUS_SESSION_ID)

    expect(resolved?.id).toBe(record.id)
  })

  test('a session with no task links nothing', async () => {
    // WHY: loose conversations that predate session-born tasks are ordinary,
    // not an error, so the link stays a no-op instead of throwing.
    const linked = await tasks.Task.linkArtifactForSession('loose-session', {
      kind: 'work',
      targetKey: 'work-orphan',
      title: 'Orphan',
    })

    expect(linked).toBeNull()
  })
})
