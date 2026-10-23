import { expect, test } from 'bun:test'
import { reduceUpdateState } from '../../apps/desktop/src/main/updates/update-status'
import { desktopUpdateMode } from '../../apps/desktop/src/main/updates/update-mode'
import { updateCommandFor, updateStatusLine } from '../../packages/workspace-ui/src/components/settings/lib/update-status-text'

test('only AppImage uses automatic Linux updates', () => {
  expect(desktopUpdateMode('linux', true, '/tmp/Solus.AppImage')).toBe('automatic')
  expect(desktopUpdateMode('linux', true)).toBe('manual')
  expect(desktopUpdateMode('darwin', true)).toBe('automatic')
  expect(desktopUpdateMode('linux', false)).toBe('development')
})
test('manual packages offer a download instead of an install promise', () => {
  expect(updateCommandFor({ kind: 'manual' })).toEqual({ command: 'download', label: 'Download Linux update' })
  expect(updateStatusLine({ kind: 'manual' })).toContain('install')
})


test('manual packages cannot report an automatic install as ready', () => {
  const state = { kind: 'manual' } as const
  expect(reduceUpdateState(state, { type: 'downloaded', release: { version: '2', releaseNotes: null, releaseDate: null } })).toBe(state)
})
