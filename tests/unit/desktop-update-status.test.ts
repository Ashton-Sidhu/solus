import { describe, expect, test } from 'bun:test'
import type { DesktopUpdateState } from '@solus/contracts/desktop-update-types'
import { reduceUpdateState, releaseFromUpdateInfo } from '@solus/desktop-main/updates/update-status'

// The update state machine from docs/plans/desktop-updates.md. What matters:
// every transition the surfaces render, and that a downloaded update is never
// demoted by a later check, progress tick, or error.

const release = { version: '0.31.0', releaseNotes: '## Notes', releaseDate: '2026-09-08' }
const idle: DesktopUpdateState = { kind: 'idle' }

describe('reduceUpdateState', () => {
  test('a check that finds nothing records when it ran', () => {
    const checking = reduceUpdateState(idle, { type: 'checking' })
    expect(checking).toEqual({ kind: 'checking' })
    expect(reduceUpdateState(checking, { type: 'not-available', at: 42 })).toEqual({ kind: 'up-to-date', checkedAt: 42 })
  })

  test('available → downloading → ready carries the release and the percent', () => {
    const available = reduceUpdateState({ kind: 'checking' }, { type: 'available', release })
    expect(available).toEqual({ kind: 'available', release })
    const downloading = reduceUpdateState(available, { type: 'download-started' })
    expect(downloading).toEqual({ kind: 'downloading', release, percent: 0 })
    expect(reduceUpdateState(downloading, { type: 'progress', percent: 55.5 })).toEqual({ kind: 'downloading', release, percent: 55.5 })
    expect(reduceUpdateState(downloading, { type: 'downloaded', release })).toEqual({ kind: 'ready', release })
  })

  test('progress without a known release is ignored', () => {
    expect(reduceUpdateState(idle, { type: 'progress', percent: 10 })).toBe(idle)
    expect(reduceUpdateState(idle, { type: 'download-started' })).toBe(idle)
  })

  test('an error keeps the release it was about, so Settings can offer Try again', () => {
    const downloading: DesktopUpdateState = { kind: 'downloading', release, percent: 30 }
    expect(reduceUpdateState(downloading, { type: 'error', message: 'offline' })).toEqual({ kind: 'error', message: 'offline', release })
    expect(reduceUpdateState({ kind: 'checking' }, { type: 'error', message: 'offline' })).toEqual({ kind: 'error', message: 'offline', release: null })
  })

  test('ready is sticky: only a restart leaves it', () => {
    const ready: DesktopUpdateState = { kind: 'ready', release }
    expect(reduceUpdateState(ready, { type: 'checking' })).toBe(ready)
    expect(reduceUpdateState(ready, { type: 'not-available', at: 1 })).toBe(ready)
    expect(reduceUpdateState(ready, { type: 'error', message: 'x' })).toBe(ready)
    expect(reduceUpdateState(ready, { type: 'progress', percent: 1 })).toBe(ready)
  })
})

describe('releaseFromUpdateInfo', () => {
  test('narrows the feed manifest to what the renderer may see', () => {
    expect(releaseFromUpdateInfo({ version: '1.0.0', releaseNotes: ' ', releaseDate: 'd' }))
      .toEqual({ version: '1.0.0', releaseNotes: null, releaseDate: 'd' })
    expect(releaseFromUpdateInfo({ version: '1.0.0', releaseNotes: [{ version: '1.0.0', note: 'a' }, { version: '0.9.0', note: null }] }))
      .toEqual({ version: '1.0.0', releaseNotes: 'a', releaseDate: null })
  })
})
