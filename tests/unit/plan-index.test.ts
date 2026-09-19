import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PlanAnnotations } from '@solus/contracts/types'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type PlanIndexModule = typeof import('@solus/server/plans/plan-index')
type DbModule = typeof import('@solus/server/db')
type AnnotationsModule = typeof import('@solus/server/plans/annotations')

let planIndex: PlanIndexModule
let closeDb: DbModule['closeDb']
let saveAnnotations: AnnotationsModule['saveAnnotations']
let dataDir: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-plan-index-'))
  process.env.SOLUS_DATA_DIR = dataDir
  planIndex = await import('@solus/server/plans/plan-index')
  ;({ closeDb } = await import('@solus/server/db'))
  ;({ saveAnnotations } = await import('@solus/server/plans/annotations'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  }
})

function plan(planToolUseId: string, timestamp: number) {
  return {
    provider: 'codex' as const,
    sessionId: 'session-1',
    planToolUseId,
    projectPath: '-Users-test-solus',
    cwd: '/Users/test/solus',
    timestamp,
    title: `Plan ${timestamp}`,
    excerpt: `Excerpt ${timestamp}`,
    content: `# Plan ${timestamp}\n\nDo the work.`,
    derivedStatus: 'pending' as const,
  }
}

describe('persistent plan index', () => {
  test('groups revisions without reading provider transcripts again', async () => {
    // WHY: Workspace must be a database query after the one-time backfill. A
    // provider-complete index is the durable boundary that makes that possible.
    await planIndex.replaceIndexedPlansForProvider('local', 'codex', [plan('plan-1', 10), plan('plan-2', 20)])

    expect(await planIndex.isPlanIndexComplete('local', 'codex')).toBe(true)
    const descriptors = await planIndex.listIndexedPlans('local', 'codex', undefined, true)
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0].planToolUseId).toBe('plan-2')
    expect(descriptors[0].revisions.map((revision) => revision.planToolUseId)).toEqual([
      'plan-2',
      'plan-1',
    ])
    expect(await planIndex.loadIndexedPlanContent('local', 'codex', 'session-1', 'plan-1')).toContain('Do the work')
  })

  test('reads review annotations without rebuilding the provider index', async () => {
    // WHY: comments and review status have their own authority. Updating them
    // must change Workspace immediately without making the provider scan history.
    await planIndex.replaceIndexedPlansForProvider('local', 'codex', [plan('plan-1', 10)])
    const annotations: PlanAnnotations = {
      version: 1,
      sessionId: 'session-1',
      projectPath: '-Users-test-solus',
      cwd: '/Users/test/solus',
      planToolUseId: 'plan-1',
      title: 'Reviewed title',
      status: 'accepted',
      comments: [{ id: 'comment-1', selectedText: 'Do', comment: 'Good', createdAt: 1 }],
      bookmarked: true,
      bookmarkedAt: 50,
      updatedAt: 1,
    }
    await saveAnnotations('local', annotations)

    const descriptor = (await planIndex.listIndexedPlans('local', 'codex', undefined, true))[0]
    expect(descriptor.title).toBe('Reviewed title')
    expect(descriptor.status).toBe('accepted')
    expect(descriptor.commentCount).toBe(1)
    expect(descriptor.bookmarked).toBe(true)
  })

  test('replaces only the changed session during incremental indexing', async () => {
    // WHY: one completed turn must not rescan or erase unrelated sessions.
    await planIndex.replaceIndexedPlansForProvider('local', 'codex', [
      plan('old', 10),
      { ...plan('other', 15), sessionId: 'session-2' },
    ])
    await planIndex.replaceIndexedPlansForSession('local', 'codex', 'session-1', [plan('new', 30)])

    const descriptors = await planIndex.listIndexedPlans('local', 'codex', undefined, true)
    expect(descriptors.map((descriptor) => descriptor.planToolUseId).sort()).toEqual(['new', 'other'])
  })

  test('keeps a saved plan when its Claude transcript expires', async () => {
    // WHY: Claude can remove the source transcript after 30 days. Workspace is
    // the durable owner of the saved plan, so expiry changes resume capability
    // instead of deleting the artifact.
    await planIndex.replaceIndexedPlansForProvider('local', 'claude-code', [
      { ...plan('saved', 10), provider: 'claude-code' },
    ])

    await planIndex.markIndexedPlanSessionUnavailable('local', 'claude-code', 'session-1')

    const descriptor = (await planIndex.listIndexedPlans('local', 'claude-code', undefined, true))[0]
    expect(descriptor.planToolUseId).toBe('saved')
    expect(descriptor.sessionAvailable).toBe(false)
    expect(await planIndex.loadIndexedPlanContent('local', 'claude-code', 'session-1', 'saved')).toContain('Do the work')

    await planIndex.replaceIndexedPlansForProvider('local', 'claude-code', [])
    expect((await planIndex.listIndexedPlans('local', 'claude-code', undefined, true))[0].planToolUseId).toBe('saved')

    await planIndex.replaceIndexedPlansForSession('local', 'claude-code', 'session-1', [
      { ...plan('saved', 10), provider: 'claude-code' },
    ])
    expect((await planIndex.listIndexedPlans('local', 'claude-code', undefined, true))[0].sessionAvailable).toBe(true)
  })
})
