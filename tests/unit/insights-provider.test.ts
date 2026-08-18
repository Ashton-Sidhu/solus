import { describe, expect, test } from 'bun:test'
import {
  providerMark,
  providerName,
} from '../../src/renderer/components/insights/lib/provider'

// Every Insights surface that shows a backend — the histogram legend and its
// band tooltip, the turn's identity line, the Summary card's captions — used to
// spell this mapping out again. These tests hold the one reading they share.

describe('provider identity', () => {
  test('both recorded spellings of Claude Code are one backend', () => {
    // WHY: the session emitter writes `claude`, the volume query reads back
    // `claude-code`. A reader must not see them as two products.
    expect(providerName('claude')).toBe('Claude Code')
    expect(providerName('claude-code')).toBe('Claude Code')
    expect(providerMark('claude')).toBe('claude')
    expect(providerMark('claude-code')).toBe('claude')
  })

  test('Codex is its own backend', () => {
    expect(providerName('codex')).toBe('Codex')
    expect(providerMark('codex')).toBe('codex')
  })

  test('an unrecognised backend gets no name and no logo', () => {
    // WHY: turns captured before the field existed have no provider, and a
    // missing measurement must never be drawn as somebody's brand. The surface
    // words the gap — "Unknown", "unknown provider", "Agent" — but none of them
    // may show a mark.
    for (const value of [null, undefined, '', 'gemini', 'Claude']) {
      expect(providerName(value)).toBeNull()
      expect(providerMark(value)).toBeNull()
    }
  })
})
