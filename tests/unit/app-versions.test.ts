import { describe, expect, test } from 'bun:test'
import {
  activationConfirmation,
  activationLabel,
  buildingVersion,
  canActivate,
  changeLog,
  deployEventDetail,
  deployEventTitle,
  deployHistory,
  lastActivation,
  liveState,
} from '@solus/client-core/app-versions'
import type { AppRevisionView, AppVersionActivation, AppVersionView } from '@solus/contracts/apps'
import type { Attribution } from '@solus/contracts/user'

// The history of an app's source and of what ran (docs/plans/apps.md §9.2): the
// one model the Versions section draws on desktop, web, and mobile.

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const OWNER: Attribution = { kind: 'user', user: { id: { kind: 'local', localId: 'owner' }, displayName: 'Ada' } }
const AGENT: Attribution = { kind: 'system' }

const revision = (commit: string, savedAt: number): AppRevisionView => ({
  commit, message: `save ${commit[0]}`, savedAt, versions: [], stats: { files: 1, additions: 2, deletions: 0 },
})
const activation = (at: number, previous: number | null, by: Attribution = AGENT): AppVersionActivation => ({ at, by, previous })
const version = (number: number, revisionCommit: string, state: AppVersionView['state'], activations: AppVersionActivation[] = []): AppVersionView => ({
  number, state, error: state === 'failed' ? 'The build failed.' : null, message: `deploy ${number}`, createdAt: number * 10, createdBy: AGENT,
  permissionsNotice: null, operationCount: 1, hasUi: true, revision: revisionCommit, protocol: 3, buildMs: 100, activations,
})

// The newest first, as the host lists them: D was saved after C, C after B, B after A.
const REVISIONS = [revision(D, 400), revision(C, 300), revision(B, 200), revision(A, 100)]

describe('the change log', () => {
  test('each save is placed against the one that runs: the saves after it do not run', () => {
    // WHY: the owner must see at a glance which source runs, and which saves wait.
    const entries = changeLog(REVISIONS, [version(1, A, 'superseded', [activation(10, null)]), version(2, B, 'active', [activation(20, 1)])])
    expect(entries.map((entry) => [entry.revision.commit[0], entry.position])).toEqual([['d', 'ahead'], ['c', 'ahead'], ['b', 'live'], ['a', 'behind']])
  })

  test('with no version live, every save waits', () => {
    expect(changeLog(REVISIONS, []).every((entry) => entry.position === 'ahead')).toBe(true)
    expect(liveState(REVISIONS, []).ahead).toHaveLength(4)
  })

  test('a save deploys when no build of it ran; one with a build that ran rolls back or forward to it instead', () => {
    // WHY: a save and a deploy are two acts. A revision whose build works is made active, not built a second time.
    const entries = changeLog(REVISIONS, [
      version(1, A, 'superseded', [activation(10, null)]),
      version(2, B, 'failed'),
      version(3, C, 'active', [activation(30, 1)]),
      version(4, D, 'building'),
    ])
    const byCommit = Object.fromEntries(entries.map((entry) => [entry.revision.commit[0], [entry.canDeploy, entry.restorable?.number ?? null]]))
    expect(byCommit).toEqual({ d: [false, null], c: [false, null], b: [true, null], a: [false, 1] })
    expect(buildingVersion([version(4, D, 'building')])?.number).toBe(4)
    expect(canActivate(version(1, A, 'superseded'))).toBe(true)
    for (const state of ['building', 'active', 'failed'] as const) expect(canActivate(version(1, A, state))).toBe(false)
  })

  test('the versions of one save are the newest first', () => {
    const entries = changeLog([revision(A, 100)], [version(1, A, 'superseded', [activation(10, null)]), version(2, A, 'active', [activation(20, 1)])])
    expect(entries[0]?.versions.map((built) => built.number)).toEqual([2, 1])
  })
})

describe('what runs now', () => {
  test('a rollback names the newer build that ran, so the owner can roll forward to it', () => {
    const versions = [
      version(1, A, 'superseded', [activation(10, null)]),
      version(2, B, 'active', [activation(20, 1), activation(40, 3, OWNER)]),
      version(3, C, 'superseded', [activation(30, 2)]),
      version(4, D, 'failed'),
    ]
    const live = liveState(REVISIONS, versions)
    expect(live.live?.number).toBe(2)
    expect(live.rolledBackFrom?.number).toBe(3)
    expect(live.ahead.map((entry) => entry.commit[0])).toEqual(['d', 'c'])
    // Since when, and by whom: the rollback, not the first deploy.
    expect(lastActivation(live.live!)).toEqual(activation(40, 3, OWNER))
  })

  test('the newest build that runs is no rollback', () => {
    expect(liveState(REVISIONS, [version(1, A, 'superseded', [activation(10, null)]), version(2, B, 'active', [activation(20, 1)])]).rolledBackFrom).toBeNull()
  })
})

describe('the deploy history', () => {
  // v1, v2, v3 deployed; v4 failed at 40; the owner rolled back to v2, forward to v3, and back to v2 again.
  const versions = [
    version(1, A, 'superseded', [activation(10, null)]),
    version(2, B, 'active', [activation(20, 1), activation(50, 3, OWNER), activation(70, 3, OWNER)]),
    version(3, C, 'superseded', [activation(30, 2), activation(60, 2, OWNER)]),
    version(4, D, 'failed'),
  ]

  test('a version first becomes active by its deploy; each later time is a rollback or a roll forward', () => {
    // WHY: "Make active" on an older version is a rollback, and the history must say who did it and from what.
    const events = deployHistory(versions)
    expect(events.map((event) => [event.kind, event.version.number, event.previous])).toEqual([
      ['rollback', 2, 3],
      ['roll-forward', 3, 2],
      ['rollback', 2, 3],
      ['failed', 4, null],
      ['deploy', 3, 2],
      ['deploy', 2, 1],
      ['deploy', 1, null],
    ])
    expect(events[0]?.by).toEqual(OWNER)
  })

  test('only the activation that put the live version in place is live', () => {
    const events = deployHistory(versions)
    expect(events.filter((event) => event.isLive).map((event) => [event.kind, event.at])).toEqual([['rollback', 70]])
  })

  test('a rollback carries the revision it left, so its change is the two revisions it moved between', () => {
    const [rollback] = deployHistory(versions)
    expect([rollback?.previousRevision, rollback?.version.revision]).toEqual([C, B])
  })

  test('each line says what happened in plain words', () => {
    const [rollback, rollForward] = deployHistory(versions)
    expect(deployEventTitle(rollback!)).toBe('Rolled back to v2')
    expect(deployEventDetail(rollback!)).toBe('From v3')
    expect(deployEventTitle(rollForward!)).toBe('Rolled forward to v3')
    const first = deployHistory(versions).at(-1)!
    expect([deployEventTitle(first), deployEventDetail(first)]).toEqual(['Deployed v1', 'The first version that ran'])
    const failed = deployHistory(versions).find((event) => event.kind === 'failed')!
    expect([deployEventTitle(failed), deployEventDetail(failed)]).toEqual(['v4 failed', 'The build failed.'])
  })
})

describe('making a version active', () => {
  test('the control says the direction against the live version', () => {
    expect(activationLabel(1, 3)).toBe('Roll back to v1')
    expect(activationLabel(4, 3)).toBe('Roll forward to v4')
    expect(activationLabel(2, null)).toBe('Roll forward to v2')
  })

  test('the question says the data is not rewound', () => {
    // WHY: decision 8 — a rollback runs older code against newer data.
    expect(activationConfirmation(1, 3)).toEqual({ title: 'Roll back to v1?', message: 'Version 1 runs from now. Its data is not rewound: what later versions wrote stays as it is.' })
  })
})
