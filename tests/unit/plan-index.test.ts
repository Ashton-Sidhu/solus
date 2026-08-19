import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { PlanAnnotations } from '@solus/contracts/types'

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

afterEach(() => {
  closeDb()
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
  test('groups revisions without reading provider transcripts again', () => {
    // WHY: Workspace must be a database query after the one-time backfill. A
    // provider-complete index is the durable boundary that makes that possible.
    planIndex.replaceIndexedPlansForProvider('codex', [plan('plan-1', 10), plan('plan-2', 20)])

    expect(planIndex.isPlanIndexComplete('codex')).toBe(true)
    const descriptors = planIndex.listIndexedPlans('codex', undefined, true)
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0].planToolUseId).toBe('plan-2')
    expect(descriptors[0].revisions.map((revision) => revision.planToolUseId)).toEqual([
      'plan-2',
      'plan-1',
    ])
    expect(planIndex.loadIndexedPlanContent('codex', 'session-1', 'plan-1')).toContain('Do the work')
  })

  test('reads review annotations without rebuilding the provider index', async () => {
    // WHY: comments and review status have their own authority. Updating them
    // must change Workspace immediately without making the provider scan history.
    planIndex.replaceIndexedPlansForProvider('codex', [plan('plan-1', 10)])
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
    await saveAnnotations(annotations)

    const descriptor = planIndex.listIndexedPlans('codex', undefined, true)[0]
    expect(descriptor.title).toBe('Reviewed title')
    expect(descriptor.status).toBe('accepted')
    expect(descriptor.commentCount).toBe(1)
    expect(descriptor.bookmarked).toBe(true)
  })

  test('replaces only the changed session during incremental indexing', () => {
    // WHY: one completed turn must not rescan or erase unrelated sessions.
    planIndex.replaceIndexedPlansForProvider('codex', [
      plan('old', 10),
      { ...plan('other', 15), sessionId: 'session-2' },
    ])
    planIndex.replaceIndexedPlansForSession('codex', 'session-1', [plan('new', 30)])

    const descriptors = planIndex.listIndexedPlans('codex', undefined, true)
    expect(descriptors.map((descriptor) => descriptor.planToolUseId).sort()).toEqual(['new', 'other'])
  })

  test('keeps a saved plan when its Claude transcript expires', () => {
    // WHY: Claude can remove the source transcript after 30 days. Workspace is
    // the durable owner of the saved plan, so expiry changes resume capability
    // instead of deleting the artifact.
    planIndex.replaceIndexedPlansForProvider('claude-code', [
      { ...plan('saved', 10), provider: 'claude-code' },
    ])

    planIndex.markIndexedPlanSessionUnavailable('claude-code', 'session-1')

    const descriptor = planIndex.listIndexedPlans('claude-code', undefined, true)[0]
    expect(descriptor.planToolUseId).toBe('saved')
    expect(descriptor.sessionAvailable).toBe(false)
    expect(planIndex.loadIndexedPlanContent('claude-code', 'session-1', 'saved')).toContain('Do the work')

    planIndex.replaceIndexedPlansForProvider('claude-code', [])
    expect(planIndex.listIndexedPlans('claude-code', undefined, true)[0].planToolUseId).toBe('saved')

    planIndex.replaceIndexedPlansForSession('claude-code', 'session-1', [
      { ...plan('saved', 10), provider: 'claude-code' },
    ])
    expect(planIndex.listIndexedPlans('claude-code', undefined, true)[0].sessionAvailable).toBe(true)
  })
})
