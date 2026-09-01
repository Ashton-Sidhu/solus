import { describe, expect, test } from 'bun:test'

import { enumeratedValues } from '@solus/workspace-ui/components/insights/lib/schema-model'

describe('schema sheet presentation', () => {
  test('the values a gloss belongs to are the ones the registry writes that way', () => {
    const kind = enumeratedValues("What happened: 'setup' (one Solus setup step), 'thinking' (provider reasoning)")
    expect(kind?.values.every((entry) => entry.gloss.length > 0)).toBe(true)

    const origin = enumeratedValues("Prompt source: 'typed', 'queued', 'automation'")
    expect(origin?.values.every((entry) => entry.gloss === '')).toBe(true)
  })
})
