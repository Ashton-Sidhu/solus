import { describe, expect, test } from 'bun:test'
import { launchLockNotes } from '@solus/workspace-ui/components/settings/policy/lib/launch-lock-notes'

// plans/030 §6.4: the provider instance editor locks exactly the launch fields a
// policy owns: all of them under a ceiling, only the pinned ones otherwise.

describe('launch lock notes', () => {
  test('a ceiling locks every launch row and says why once', () => {
    const notes = launchLockNotes({ all: true, binaryPath: true, launchArgs: true, environment: [], message: 'Globex sets how agents start.' })
    expect([notes.binaryPath, notes.homePaths, notes.launchArgs, notes.environment].every((note) => note?.lockedEverywhere)).toBe(true)
    expect([notes.binaryPath, notes.homePaths, notes.launchArgs, notes.environment].flatMap((note) => note?.lines ?? [])).toEqual(['Globex sets how agents start.'])
  })

  test('pins lock only their own fields; pinned variables are named and the others stay editable', () => {
    const notes = launchLockNotes({ all: false, binaryPath: true, launchArgs: false, environment: ['CLAUDE_CODE_USE_BEDROCK'], message: 'IT pins some launch settings.' })
    expect(notes.binaryPath).toEqual({ lockedEverywhere: true, lines: ['IT pins some launch settings.'] })
    expect(notes.homePaths).toBeUndefined()
    expect(notes.launchArgs).toBeUndefined()
    expect(notes.environment).toEqual({ lockedEverywhere: false, lines: ['Pinned variables: CLAUDE_CODE_USE_BEDROCK.'] })
    expect(notes.pinnedVariables).toEqual(['CLAUDE_CODE_USE_BEDROCK'])
  })

  test('no lock leaves every row to the person', () => {
    expect(launchLockNotes(null)).toEqual({ pinnedVariables: [] })
  })
})
