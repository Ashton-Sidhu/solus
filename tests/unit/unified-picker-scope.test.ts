import { describe, expect, test } from 'bun:test'
import {
  pickerProjectKeys,
  resolvePickerScope,
  scopeForChoice,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-scope'

/**
 * The picker opens where the user already is, and keeps doing so as the user
 * moves. These assert the two halves of that: the default follows the composer,
 * and an explicit choice is only sticky when it is genuinely somewhere else.
 */
describe('picker scope', () => {
  test('the default follows the composer rather than pinning a project', () => {
    expect(resolvePickerScope({ kind: 'current' }, 'model-routing')).toBe('model-routing')
    // The same scope value, read again after the composer moved.
    expect(resolvePickerScope({ kind: 'current' }, 'solus')).toBe('solus')
  })

  test('a composer in no project leaves the list wide rather than empty', () => {
    expect(resolvePickerScope({ kind: 'current' }, null)).toBeNull()
  })

  test('an explicit choice holds against the composer', () => {
    expect(resolvePickerScope({ kind: 'project', projectKey: 'solus' }, 'model-routing')).toBe('solus')
    expect(resolvePickerScope({ kind: 'all' }, 'model-routing')).toBeNull()
  })

  test('choosing the composer’s own project resumes following it', () => {
    // Pinning it instead would go stale the moment the user moved on, with no
    // visible difference in the control to explain why.
    expect(scopeForChoice('model-routing', 'model-routing')).toEqual({ kind: 'current' })
    expect(scopeForChoice('solus', 'model-routing')).toEqual({ kind: 'project', projectKey: 'solus' })
    expect(scopeForChoice(null, 'model-routing')).toEqual({ kind: 'all' })
  })
})

describe('picker project keys', () => {
  test('the composer’s project leads, then every known project, each once', () => {
    // Leaving the composer's project out would make the default scope
    // unnameable in its own menu, and a fresh project has no other trace.
    expect(pickerProjectKeys('github.com/me/fresh', ['github.com/me/solus'])).toEqual(['github.com/me/fresh', 'github.com/me/solus'])
    expect(pickerProjectKeys('github.com/me/solus', ['github.com/me/model-routing', 'github.com/me/solus']))
      .toEqual(['github.com/me/solus', 'github.com/me/model-routing'])
  })

  test('a composer in no project offers the known projects', () => {
    // WHY: a task belongs to no project, so tasks add no scope; the known
    // projects are the only scopes.
    expect(pickerProjectKeys(null, ['github.com/me/sessions-only'])).toEqual(['github.com/me/sessions-only'])
  })
})
