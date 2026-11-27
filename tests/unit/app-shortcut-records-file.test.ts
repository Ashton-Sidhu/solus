import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APP_SHORTCUT_RECORDS_FILE, openAppShortcutRecords } from '@solus/desktop-main/app-shortcuts/app-shortcut-records'
import { SUMMON_SHORTCUT_FILE, loadSummonShortcut, saveSummonShortcut } from '@solus/desktop-main/summon-shortcut-file'

// The app shortcut records (shortcuts, window places, permission answers) and
// the global summon shortcut are two features of the desktop app. Each one
// keeps its own file in the desktop app's data folder: when they shared
// `app-shortcuts.json`, a save of one destroyed the other, and a new summon
// shortcut deleted every app shortcut and every permission answer.

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solus-records-file-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const notes = { host: '0123456789abcdef0123456789abcdef', appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }
const DEFAULT_SUMMON = { toggle: { code: 'Space', alt: true, shift: true } }
const NEW_SUMMON = { toggle: { code: 'KeyK', mod: true, shift: true } }

describe('the app shortcut records file', () => {
  test('a save of the summon shortcut keeps the app shortcuts and their permission answers', () => {
    const records = openAppShortcutRecords(dir)
    records.save({ ...notes, name: 'Notes', launcherPath: '/Apps/Notes.app', iconKey: 'monogram:N:235', launcherFormat: 1 })
    records.setGrant(notes, 'Notes', 'notifications', 'granted')

    saveSummonShortcut(dir, NEW_SUMMON)

    const again = openAppShortcutRecords(dir)
    expect(again.find(notes)?.name).toBe('Notes')
    expect(again.grantOf(notes, 'notifications')).toBe('granted')
    expect(loadSummonShortcut(dir, DEFAULT_SUMMON)).toEqual(NEW_SUMMON)
  })

  test('a save of an app shortcut keeps the summon shortcut', () => {
    saveSummonShortcut(dir, NEW_SUMMON)
    openAppShortcutRecords(dir).saveWindowBounds(notes, { x: 10, y: 20, width: 800, height: 600 })
    expect(loadSummonShortcut(dir, DEFAULT_SUMMON)).toEqual(NEW_SUMMON)
  })

  // WHY: a person who added shortcuts before the files were apart has them in the shared file. They must survive the update.
  test('records in the shared file move to their own file at the first open', () => {
    const shared = {
      version: 1,
      shortcuts: [{ ...notes, name: 'Notes', launcherPath: '/Apps/Notes.app' }],
      windowBounds: {},
    }
    writeFileSync(join(dir, SUMMON_SHORTCUT_FILE), JSON.stringify(shared))

    const records = openAppShortcutRecords(dir)

    expect(records.find(notes)?.launcherPath).toBe('/Apps/Notes.app')
    expect(existsSync(join(dir, SUMMON_SHORTCUT_FILE))).toBe(false)
    expect(loadSummonShortcut(dir, DEFAULT_SUMMON)).toEqual(DEFAULT_SUMMON)
  })

  test('a summon shortcut in the shared file stays where it is', () => {
    saveSummonShortcut(dir, NEW_SUMMON)
    const records = openAppShortcutRecords(dir)
    expect(records.list()).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, SUMMON_SHORTCUT_FILE), 'utf-8'))).toEqual(NEW_SUMMON)
  })

  test('records that have their own file are not replaced by an older shared file', () => {
    openAppShortcutRecords(dir).save({ ...notes, name: 'Notes', launcherPath: '/Apps/Notes.app', iconKey: '', launcherFormat: 1 })
    writeFileSync(join(dir, SUMMON_SHORTCUT_FILE), JSON.stringify({ version: 1, shortcuts: [], windowBounds: {} }))
    expect(openAppShortcutRecords(dir).find(notes)?.name).toBe('Notes')
    expect(APP_SHORTCUT_RECORDS_FILE).not.toBe(SUMMON_SHORTCUT_FILE)
  })
})
