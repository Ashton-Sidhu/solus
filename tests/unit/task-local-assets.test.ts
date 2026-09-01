import { describe, expect, test } from 'bun:test'
import { containsLocalAsset } from '@solus/server/tasks/task-assets'

describe('task local assets', () => {
  test('keeps content-addressed attachments out of provider text publishing', () => {
    const id = `${'a'.repeat(64)}.png`
    expect(containsLocalAsset(`See ![screen](asset://${id})`)).toBe(true)
    expect(containsLocalAsset(`See [brief](asset://${'b'.repeat(64)}.pdf)`)).toBe(true)
    expect(containsLocalAsset('See https://example.com/screen.png')).toBe(false)
    expect(containsLocalAsset('asset://not-a-valid-id.png')).toBe(false)
  })
})
