import { describe, expect, test } from 'bun:test'
import { executionPreferenceSnapshotSchema, knownExecutionPreferences, storedExecutionPreferencesSchema, type ExecutionPreferences } from '@solus/contracts/settings'

// A record stored by an older version can hold a key a later version removed.
const storedBeforeRemoval = { extraInstructions: 'Be brief.', retiredPreference: 'on' }

describe('stored execution preferences', () => {
  // docs/plans/host-preferences.md: a client newer or older than its host never makes a call fail.
  test('a host keeps the keys it knows from a set a client writes, and names the others', () => {
    // SAFETY: a client of another version sends keys this version does not have, and a value it does not accept.
    const sent = { ...storedBeforeRemoval, rateLimitBehavior: 'later' } as ExecutionPreferences
    expect(knownExecutionPreferences(sent)).toEqual({ preferences: { extraInstructions: 'Be brief.' }, ignored: ['rateLimitBehavior', 'retiredPreference'] })
  })

  test('a stored record drops a removed key and keeps the other choices', () => {
    expect(storedExecutionPreferencesSchema.parse(storedBeforeRemoval)).toEqual({ extraInstructions: 'Be brief.' })
    // An automation's snapshot must still load, or the scheduler tick fails for every automation.
    expect(executionPreferenceSnapshotSchema.parse({ capturedAt: 1, preferences: storedBeforeRemoval }))
      .toEqual({ capturedAt: 1, preferences: { extraInstructions: 'Be brief.' } })
  })

  test('a stored record with a bad value is still refused', () => {
    expect(storedExecutionPreferencesSchema.safeParse({ extraInstructions: 42 }).success).toBe(false)
  })
})
