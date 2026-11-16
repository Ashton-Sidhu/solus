import { describe, expect, test } from 'bun:test'
import type { AppCallView, AppScheduleView, AppSessionLink, AppSummary, AppVersionView } from '@solus/contracts/apps'
import {
  activeVersionDescription,
  agentAccessText,
  appMetaLine,
  madeByText,
  oneLine,
  recentDeployRows,
  recentFailureRows,
  revisionNote,
  scheduleOverviewLine,
  sessionsLine,
  textPatch,
} from '../../apps/mobile/src/features/apps/app-overview'
import { appTileColors, oklchToHex } from '../../apps/mobile/src/features/apps/app-tile-colors'

// The Overview of an app on the phone (docs/plans/apps.md §9.2). These pin
// what the owner reads and what a change sends: the tile has the desktop's
// colours, a blur that changed nothing sends nothing, an empty field goes back
// to the manifest, and the short lists show the newest items only.

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const MINUTE = 60_000
const ada: AppSummary['createdBy'] = { kind: 'user', user: { id: { kind: 'local', localId: 'u1' }, displayName: 'Ada' } }

function call(overrides: Partial<AppCallView> = {}): AppCallView {
  return {
    id: 'call-1',
    version: 3,
    kind: 'operation',
    operation: 'list',
    caller: { kind: 'ui' },
    startedAt: NOW - 5 * MINUTE,
    finishedAt: NOW - 5 * MINUTE + 100,
    outcome: 'failed',
    error: 'Error: boom',
    durationMs: 100,
    logCount: 0,
    spanCount: 0,
    traceId: null,
    spanId: null,
    ...overrides,
  }
}

function version(overrides: Partial<AppVersionView> = {}): AppVersionView {
  return {
    number: 3,
    state: 'active',
    error: null,
    message: 'Add the export',
    createdAt: NOW - 120 * MINUTE,
    createdBy: ada,
    permissionsNotice: null,
    operationCount: 2,
    hasUi: true,
    revision: 'c'.repeat(40),
    protocol: 1,
    buildMs: 900,
    activations: [{ at: NOW - 60 * MINUTE, by: ada, previous: 2 }],
    ...overrides,
  }
}

describe('app tile colours', () => {
  test('the OKLCH conversion gives the sRGB colour a browser draws', () => {
    // The phone cannot read OKLCH, so a wrong conversion gives the tile another colour than on the desktop.
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff')
    expect(oklchToHex(0, 0, 0)).toBe('#000000')
    expect(oklchToHex(0.627955, 0.257683, 29.2339)).toBe('#ff0000')
    expect(oklchToHex(0.452014, 0.313214, 264.052)).toBe('#0000ff')
  })

  test('a colour outside sRGB is clipped, not wrapped', () => {
    expect(oklchToHex(0.7, 0.5, 145)).toMatch(/^#[0-9a-f]{6}$/)
  })

  test('light mode has a pale tile with a dark letter, and dark mode the reverse', () => {
    const light = appTileColors(235, 'light')
    const dark = appTileColors(235, 'dark')
    expect(light).toEqual({ background: oklchToHex(0.9, 0.06, 235), text: oklchToHex(0.42, 0.1, 235) })
    expect(dark).toEqual({ background: oklchToHex(0.38, 0.07, 235), text: oklchToHex(0.9, 0.05, 235) })
  })
})

describe('name and description', () => {
  test('a field that loses focus with the same text sends no change', () => {
    expect(textPatch('Reports', 'Reports')).toBeUndefined()
    expect(textPatch('  Reports ', 'Reports')).toBeUndefined()
  })

  test('an empty field resets to the manifest text, and new text is sent without the spaces around it', () => {
    expect(textPatch('   ', 'My reports')).toBeNull()
    expect(textPatch(' Sales ', 'Reports')).toBe('Sales')
  })

  test('the header line names the slug, the version that runs, and the host', () => {
    expect(appMetaLine({ slug: 'reports', activeVersion: 3 }, 'Studio')).toBe('reports · v3 · Studio')
    expect(appMetaLine({ slug: 'reports', activeVersion: null }, null)).toBe('reports')
  })
})

describe('status', () => {
  test('the version row says when and by whom the version that runs was deployed', () => {
    // A rollback makes an old version active again: the time is the newest activation, not the build.
    const versions = [version(), version({ number: 2, state: 'superseded' })]
    expect(activeVersionDescription({ activeVersion: 3, hasUndeployedRevision: false }, versions, NOW)).toBe('Deployed 1h ago by Ada')
  })

  test('the version row says a save waits, and says nothing it has not read', () => {
    expect(activeVersionDescription({ activeVersion: 3, hasUndeployedRevision: true }, null, NOW)).toBe('A newer save waits for a deploy.')
    expect(activeVersionDescription({ activeVersion: null, hasUndeployedRevision: false }, [], NOW)).toBeUndefined()
  })

  test('agent access says what agents can call', () => {
    expect(agentAccessText({ agentAccess: true, operationCount: 1 })).toBe('Agents can call its operation as a tool.')
    expect(agentAccessText({ agentAccess: true, operationCount: 4 })).toBe('Agents can call its 4 operations as tools.')
    expect(agentAccessText({ agentAccess: false, operationCount: 4 })).toBe('Agents cannot call this app.')
  })
})

describe('recent failures', () => {
  test('the newest five failed calls show, the newest first', () => {
    const calls = Array.from({ length: 7 }, (_, index) => call({ id: `call-${index}`, startedAt: NOW - (index + 1) * MINUTE }))
    const rows = recentFailureRows([...calls].reverse(), NOW)
    expect(rows.map((row) => row.callId)).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4'])
    expect(rows[0]).toMatchObject({ title: 'list', trailing: '1m ago', lines: [{ text: 'Error: boom', tone: 'danger' }] })
  })

  test('a row shows only the first line of a long error, and opens a model call as a model call', () => {
    const stack = `TypeError: x is undefined\n    at run (app.ts:3)\n    at main (app.ts:9)`
    const [row] = recentFailureRows([call({ kind: 'model', operation: 'summary', error: stack })], NOW)
    expect(row).toMatchObject({ kind: 'model', title: 'Model · summary', lines: [{ text: 'TypeError: x is undefined', tone: 'danger' }] })
    expect(oneLine('a'.repeat(300))).toHaveLength(120)
  })

  test('a failed call with no error still says it failed', () => {
    expect(recentFailureRows([call({ error: null })], NOW)[0]?.lines).toEqual([{ text: 'Failed', tone: 'danger' }])
  })
})

describe('recent deploys', () => {
  test('the newest three versions show with their message, who, when, and how they ended', () => {
    const rows = recentDeployRows(
      [
        version({ number: 1, state: 'superseded' }),
        version({ number: 4, state: 'failed', message: '', createdAt: NOW - 10 * MINUTE }),
        version({ number: 3 }),
        version({ number: 2, state: 'superseded' }),
      ],
      NOW,
    )
    // The state is the mark of the row and words in its last line: a failure in the failure colour, and no word for a version that ran before.
    expect(rows.map((row) => [row.title, row.state, row.lines.at(-1)])).toEqual([
      ['Version 4', 'failed', { text: 'Failed · Ada · 10m ago', tone: 'danger' }],
      ['Version 3', 'ok', { text: 'Active · Ada · 2h ago' }],
      ['Version 2', 'idle', { text: 'Ada · 2h ago' }],
    ])
    expect(rows[0]?.lines[0]).toEqual({ text: 'No message' })
  })
})

describe('schedules', () => {
  const schedule: AppScheduleView = {
    name: 'nightly',
    trigger: { type: 'cron', expr: '0 2 * * *' },
    run: 'request',
    enabled: true,
    nextRunAt: NOW + 90 * MINUTE,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
  }

  test('a schedule says when it runs and when it runs next', () => {
    expect(scheduleOverviewLine(schedule, false, NOW)).toStartWith('Every day at 02:00 · Next: in 1h · ')
  })

  test('a schedule that cannot fire shows no time to run next', () => {
    // A stopped app or a paused schedule does not fire, so a time there is a lie.
    expect(scheduleOverviewLine(schedule, true, NOW)).toBe('Every day at 02:00 · Next: When the app starts')
    expect(scheduleOverviewLine({ ...schedule, enabled: false }, false, NOW)).toBe('Every day at 02:00 · Next: Paused')
  })
})

describe('source', () => {
  const link: AppSessionLink = { sessionId: 's1', title: 'Make reports', linkedAt: NOW, provider: null, status: null, lastActivityAt: null }

  test('made by names who and the day', () => {
    expect(madeByText({ createdBy: ada, createdAt: NOW })).toStartWith('Ada · ')
    expect(madeByText({ createdBy: ada, createdAt: NOW })).toContain('2026')
  })

  test('sessions shows a count only after the read, never a zero it did not read', () => {
    expect(sessionsLine({ kind: 'loaded', value: [link, { ...link, sessionId: 's2' }] }, true)).toBe('2 sessions worked on this app.')
    expect(sessionsLine({ kind: 'loaded', value: [link] }, false)).toBe('1 session worked on this app.')
    expect(sessionsLine({ kind: 'loaded', value: [] }, true)).toBe('No session is linked to this app.')
    expect(sessionsLine({ kind: 'loading' }, true)).toBe('Reading…')
    expect(sessionsLine({ kind: 'loading' }, false)).toBe('The count shows when this host is connected.')
    expect(sessionsLine({ kind: 'error', message: 'Timed out.' }, true)).toBe('Not read: Timed out.')
  })

  test('the newest revision says whether a version was built from it', () => {
    expect(revisionNote({ latestRevision: null, hasUndeployedRevision: false })).toBe('Nothing was saved yet.')
    expect(revisionNote({ latestRevision: 'c'.repeat(40), hasUndeployedRevision: true })).toBe('It waits for a deploy.')
    expect(revisionNote({ latestRevision: 'c'.repeat(40), hasUndeployedRevision: false })).toBe('A version was built from it.')
  })
})
