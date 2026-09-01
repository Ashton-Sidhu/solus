import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The diff / review-guide comment bar used to carry two send buttons: an arrow
// that replied in the current session and a split arrow that opened a fresh
// one. The destination was a property of which button you hit, and the two sat
// side by side with no visual grouping — so the bar read as having a duplicate
// submit. One send now, and the destination is a state you can see and change
// before pressing it.

const UI = new URL('../../packages/workspace-ui/src/', import.meta.url).pathname
const bar = readFileSync(`${UI}components/diff/DiffActionBar.svelte`, 'utf8')
const composer = readFileSync(`${UI}components/ui/prompt-composer/prompt-composer.svelte`, 'utf8')

describe('diff comment bar actions', () => {
  test('the bar contributes no second send button', () => {
    // WHY: this is the finding, stated as a rule. The composer owns exactly one
    // send; anything the bar adds to the row is a modifier, never another way
    // to dispatch the same draft.
    expect(bar).not.toContain('aria-label="Send to new session"')
    expect((composer.match(/aria-label="Send"/gu) ?? []).length).toBe(1)
  })

  test('the destination is a visible, reversible toggle', () => {
    // WHY: a hidden destination is what forced the second button. The toggle
    // has to report its own state, or the single send is ambiguous instead of
    // simple.
    expect(bar).toContain('data-testid="diff-action-new-session"')
    expect(bar).toContain('aria-pressed={startNewSession}')
  })

  test('the keyboard path to a new session did not get longer', () => {
    // WHY: collapsing two buttons into one is only a simplification if the
    // power path survives. ⌘⇧↵ still dispatches to a fresh session whatever
    // the toggle says.
    expect(bar).toContain('handleSendToNewSession')
    expect(bar).toMatch(/e\.shiftKey[\s\S]{0,200}handleSendToNewSession/u)
  })

  test('the worktree choice only appears where it means something', () => {
    // WHY: it was a labelled switch sitting in the row at all times, but an
    // isolated checkout is only created on the new-session path — so on a reply
    // it was a control that did nothing, spending the width the model chip's
    // label needs.
    expect(bar).toContain('toNewSession && !!sess?.run.gitContext')
    expect(composer).not.toContain('showWorktree')
  })
})
