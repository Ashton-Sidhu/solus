import { describe, expect, test } from 'bun:test'
import type { AttentionKind } from '@solus/contracts/attention-types'
import type { Session, SessionStatus, Tab } from '@solus/contracts/types'
import {
  attentionStateForKind,
  getAttentionMark,
  getAttentionState,
} from '@solus/workspace-ui/lib/sessionUtils'

// A session-attention toast draws the sidebar's glyph for its kind. These are
// the session situations the host raises each kind for; the sidebar derives its
// row glyph from the same situation, so the two must show the same icon.
function situation(status: SessionStatus, pending: 'permission' | 'question' | null, hasUnread: boolean) {
  const session = {
    status,
    permissionQueue: pending === 'permission' ? [{}] : [],
    questionQueue: pending === 'question' ? [{}] : [],
    messages: [],
  } as unknown as Session
  const tab = { hasUnread } as Tab
  return { session, tab }
}

const RAISED_BY: Record<AttentionKind, ReturnType<typeof situation>> = {
  needs_approval: situation('awaiting_input', 'permission', false),
  question: situation('awaiting_input', 'question', false),
  failed: situation('failed', null, true),
  finished: situation('completed', null, true),
}

describe('session-attention toast icon', () => {
  for (const kind of Object.keys(RAISED_BY) as AttentionKind[]) {
    test(`${kind} toast shows the sidebar glyph and color for that session`, () => {
      const { session, tab } = RAISED_BY[kind]
      const sidebarIcon = getAttentionMark(getAttentionState(session, tab))
      const toastIcon = getAttentionMark(attentionStateForKind(kind))

      expect(sidebarIcon).not.toBeNull()
      expect(toastIcon).toEqual(sidebarIcon)
    })
  }

  const glyphOf = (kind: AttentionKind) => {
    const mark = getAttentionMark(attentionStateForKind(kind))
    return mark?.kind === 'glyph' ? mark.component : null
  }

  test('a failure toast is not drawn like an input request', () => {
    expect(glyphOf('failed')).not.toBe(glyphOf('question'))
  })

  test('an approval toast is not drawn like a question', () => {
    // WHY: a permission request and a question want different answers, so the
    // shield and the question bubble must differ wherever they show.
    expect(attentionStateForKind('needs_approval')).toBe('approval')
    expect(attentionStateForKind('question')).toBe('awaiting')
    expect(glyphOf('needs_approval')).not.toBeNull()
    expect(glyphOf('needs_approval')).not.toBe(glyphOf('question'))
  })
})
