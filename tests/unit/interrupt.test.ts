import { describe, expect, test } from 'bun:test'
import { optionLabelParts } from '@solus/workspace-ui/components/conversation/lib/interrupt'

/**
 * §11 — an option label is one line the reader chooses by, so a recommendation is
 * a note beside it, never part of its name. Callers can only append it to the
 * label, so the card is what has to pull it back out.
 */
describe('option labels', () => {
  test('a trailing recommendation becomes a note, whatever separates it', () => {
    expect(optionLabelParts('Same row, rewrites in place (Recommended)')).toEqual({
      text: 'Same row, rewrites in place',
      note: 'recommended',
    })
    expect(optionLabelParts('Keep 500 · (recommended)')).toEqual({
      text: 'Keep 500',
      note: 'recommended',
    })
  })

  test('a label that only mentions the word keeps it, because it is the choice', () => {
    expect(optionLabelParts('Use the recommended defaults')).toEqual({
      text: 'Use the recommended defaults',
      note: '',
    })
  })
})

import { permissionScope } from '@solus/workspace-ui/components/conversation/lib/interrupt'

/**
 * The footer names what a grant means before the click, so a broad grant is
 * never approved by its label alone. The provider sends ids, so the sentence
 * follows the id, and an id the card does not know gets no sentence.
 */
describe('permission scope', () => {
  test('the narrowest grant is one call; the session grant names the tool and the session', () => {
    expect(permissionScope('allow', 'Bash', 'Claude')).toBe('This call only. Claude asks again next time.')
    expect(permissionScope('accept', 'exec_command', 'Codex')).toBe('This call only. Codex asks again next time.')
    expect(permissionScope('allow-session', 'Bash', 'Claude')).toBe('Every Bash call in this session, until the session ends.')
    expect(permissionScope('acceptForSession', 'exec_command', 'Codex')).toBe('Every exec_command call in this session, until the session ends.')
  })

  test('an exec-policy amendment reaches later sessions, and a denial runs nothing', () => {
    expect(permissionScope('acceptWithExecpolicyAmendment', 'exec_command', 'Codex')).toBe('Commands that match this one, in this and later sessions.')
    expect(permissionScope('deny', 'Bash', 'Claude')).toBe('Nothing runs. Claude continues without it.')
    expect(permissionScope('decline', 'exec_command', 'Codex')).toBe('Nothing runs. Codex continues without it.')
  })

  test('an unknown id gets no sentence rather than a wrong one', () => {
    expect(permissionScope('acceptWithCustomRule', 'Bash', 'Claude')).toBe('')
  })
})
