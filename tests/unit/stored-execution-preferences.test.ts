import { describe, expect, test } from 'bun:test'
import { executionPreferenceSnapshotSchema, executionPreferencesSchema, storedExecutionPreferencesSchema } from '@solus/contracts/settings'

// A record stored by an older version can hold a key a later version removed.
const storedBeforeRemoval = { extraInstructions: 'Be brief.', retiredPreference: 'on' }

describe('stored execution preferences', () => {
  test('a request that sends a removed key is still refused', () => {
    expect(executionPreferencesSchema.safeParse(storedBeforeRemoval).success).toBe(false)
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
