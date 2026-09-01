import { describe, expect, test } from 'bun:test'
import { assetFileMarkdown, assetImageMarkdown } from '@solus/workspace-ui/lib/asset-upload'

describe('asset image Markdown', () => {
  test('inserts a stable asset reference without embedding image bytes', () => {
    const uri = `asset://${'a'.repeat(64)}.png`
    expect(assetImageMarkdown('screen [final].png', uri)).toBe(
      `![screen \\[final\\].png](${uri})`,
    )
  })

  test('uses a normal Markdown link for a general attachment', () => {
    const uri = `asset://${'b'.repeat(64)}.pdf`
    expect(assetFileMarkdown('brief [final].pdf', uri)).toBe(
      `[brief \\[final\\].pdf](${uri})`,
    )
  })
})
