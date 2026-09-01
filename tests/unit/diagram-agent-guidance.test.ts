import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from '@solus/server/agents/system-hint'

describe('diagram agent guidance', () => {
  test('teaches both creation and preservation of live embeds', () => {
    const prompt = buildSystemPrompt({ agent: 'codex', general: false })
    expect(prompt).toContain('diagram work first and embed the token returned by create_work')
    expect(prompt).toContain('A standalone work://embed link is a live diagram embed. Preserve it')
  })
})
