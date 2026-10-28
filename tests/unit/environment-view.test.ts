import { describe, expect, test } from 'bun:test'
import {
  environmentViewFor,
  sessionArtifacts,
  type EnvironmentViewFacts,
} from '@solus/client-core/environment-view'
import { EnvironmentViewChoices } from '@solus/workspace-ui/components/project-panel/lib/environment-view'
import { environmentViewMenu, phoneEnvironmentFacts, transcriptArtifacts } from '../../apps/mobile/src/features/threads/environment-view-menu'
import type { TranscriptItem } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import type { WorkMeta, WorkType } from '@solus/contracts/types'

/**
 * The Environment card has one row for the browser, the builds, and the
 * artifacts. The row must open what the session is about without a guess,
 * and the user's choice must hold for that session only.
 */

const plain: EnvironmentViewFacts = { sessionShowsDevice: false, artifactCount: 0, artifactsKnown: true }

function work(id: string, type: WorkType, sessionIds: string[], updatedAt: string): WorkMeta & { id: string } {
  return { id, type, sessionIds, updatedAt, organizationId: 'local', title: id, preview: '', createdAt: updatedAt, agentProvider: 'claude-code', cwd: '/p' }
}

describe('environment view rule', () => {
  test('a session with nothing to show opens the browser', () => {
    expect(environmentViewFor(plain)).toBe('browser')
  })

  test('a session that shows a device opens its builds, before its artifacts', () => {
    expect(environmentViewFor({ ...plain, sessionShowsDevice: true, artifactCount: 2 })).toBe('builds')
  })

  test('the view waits for the artifacts instead of naming Browser first', () => {
    // WHY: the first panel open must not show Browser and then change to Artifacts.
    expect(environmentViewFor({ ...plain, artifactsKnown: false })).toBeNull()
    // A device or a choice already decides the view; nothing to wait for.
    expect(environmentViewFor({ ...plain, artifactsKnown: false, sessionShowsDevice: true })).toBe('builds')
    expect(environmentViewFor({ ...plain, artifactsKnown: false, chosen: 'browser' })).toBe('browser')
  })

  test('a session with an artifact opens the artifacts', () => {
    expect(environmentViewFor({ ...plain, artifactCount: 1 })).toBe('artifacts')
  })

  test('the user choice always wins, even with nothing to show', () => {
    // WHY: every item opens; the panes own their empty states.
    const facts = { ...plain, sessionShowsDevice: true, artifactCount: 1 }
    expect(environmentViewFor({ ...facts, chosen: 'browser' })).toBe('browser')
    expect(environmentViewFor({ ...plain, chosen: 'artifacts' })).toBe('artifacts')
    expect(environmentViewFor({ ...plain, chosen: 'builds' })).toBe('builds')
  })
})

describe('session artifacts', () => {
  test('only artifacts linked to the session count, the last changed first', () => {
    const works = [
      work('old', 'artifact', ['s1'], '2026-01-01T00:00:00Z'),
      work('doc', 'doc', ['s1'], '2026-03-01T00:00:00Z'),
      work('other', 'artifact', ['s2'], '2026-03-01T00:00:00Z'),
      work('new', 'artifact', ['s0', 's1'], '2026-02-01T00:00:00Z'),
    ]
    expect(sessionArtifacts(works, 's1').map((w) => w.id)).toEqual(['new', 'old'])
    expect(sessionArtifacts(works, undefined)).toEqual([])
  })
})

describe('per-session choice', () => {
  test('a choice holds for its session only, and can change', () => {
    const choices = new EnvironmentViewChoices()
    choices.choose('host-a', 's1', 'artifacts')
    expect(choices.chosenFor('host-a', 's1')).toBe('artifacts')
    // Switching to another session, or the same id on another host, starts clean.
    expect(choices.chosenFor('host-a', 's2')).toBeUndefined()
    expect(choices.chosenFor('host-b', 's1')).toBeUndefined()
    choices.choose('host-a', 's1', 'browser')
    expect(choices.chosenFor('host-a', 's1')).toBe('browser')
  })
})

describe('phone environment menu', () => {
  const artifact = (id: string, workId: string | null): TranscriptItem => ({ kind: 'artifact', id, html: '<p/>', title: id, workId })
  const text = (id: string) => ({ kind: 'notice', id }) as unknown as TranscriptItem

  test('revisions of one work count once, and the newest row opens', () => {
    const rows = new Map<string, TranscriptItem>([['a', artifact('a', 'w1')], ['n', text('n')], ['b', artifact('b', 'w1')], ['c', artifact('c', null)]])
    expect(transcriptArtifacts(['a', 'n', 'b', 'c'], (id) => rows.get(id))).toEqual({ latestId: 'c', count: 2 })
    expect(transcriptArtifacts(['n'], (id) => rows.get(id))).toEqual({ latestId: null, count: 0 })
  })

  test('the menu lists all three views, each one can be chosen', () => {
    const chosen: string[] = []
    const menu = environmentViewMenu(phoneEnvironmentFacts({ artifactCount: 1, artifactsKnown: true }), (view) => chosen.push(view))
    expect(menu.status).toBe('Artifacts')
    const items = menu.items.flatMap((item) => ('items' in item ? [] : [item]))
    expect(items.map((item) => [item.id, item.disabled ?? false, item.selected])).toEqual([
      ['browser', false, false],
      ['builds', false, false],
      ['artifacts', false, true],
    ])
    for (const item of items) item.onPress()
    expect(chosen).toEqual(['browser', 'builds', 'artifacts'])
  })

  test('a phone session without artifacts falls back to Browser, after the transcript loads', () => {
    expect(environmentViewMenu(phoneEnvironmentFacts({ artifactCount: 0, artifactsKnown: false }), () => {}).status).toBe('Checking session…')
    expect(environmentViewMenu(phoneEnvironmentFacts({ artifactCount: 0, artifactsKnown: true }), () => {}).status).toBe('Browser')
  })
})
