import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import type { SessionActiveTurn } from '@solus/contracts/presence'
import {
  callTitle,
  limitTitle,
  needsLabel,
  otherPerson,
  permissionDecisionNotice,
  steerPlaceholder,
  waitingOnLabel,
} from '@solus/workspace-ui/components/presence/lib/actor-name'
import { othersTurnTitle } from '@solus/workspace-ui/components/conversation/lib/interrupt'
import { statusNote } from '@solus/workspace-ui/components/conversation/lib/session-breadcrumb'
import { planTypeLabel } from '@solus/workspace-ui/components/plan/lib/plan-type-label'
import { turnRefusalCopy } from '@solus/workspace-ui/components/connections/lib/turn-refusal-copy'
import { applySessionTitleChange } from '@solus/workspace-ui/contexts/workspace/session-title-change'
import type { User, UserId } from '@solus/contracts/user'

// plans/004-shared-host-collaboration.md stage 4: a label names a teammate, says
// "you" only to the reader, stays quiet when the reader acts alone, and shows no
// name when the host did not say who it was — never a guess.
const ALICE: User = { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice Moreau' }
const READER: UserId = { kind: 'account', accountId: 'bob' }
const SELF_ALICE: UserId = { kind: 'account', accountId: 'alice' }

describe('whose turn, for the reader', () => {
  test('only someone other than a known reader is named', () => {
    expect(otherPerson(ALICE, READER)).toEqual(ALICE)
    expect(otherPerson(ALICE, SELF_ALICE)).toBeNull()
    expect(otherPerson(ALICE, null)).toBeNull()
    expect(otherPerson(undefined, READER)).toBeNull()
  })

  test('a waiting session and question address the turn\'s author', () => {
    expect(needsLabel(ALICE, READER)).toBe('Needs Alice')
    expect(needsLabel(ALICE, SELF_ALICE)).toBe('Needs you')
    expect(needsLabel(undefined, READER)).toBe('Needs you')
    expect(waitingOnLabel(ALICE, READER)).toBe('Waiting on Alice')
    expect(waitingOnLabel(ALICE, SELF_ALICE)).toBe('Waiting on you')
    expect(callTitle('Linear', ALICE, READER)).toBe('Linear needs Alice\'s call')
    expect(callTitle(undefined, ALICE, SELF_ALICE)).toBe('Needs your call')
    expect(statusNote('question', needsLabel(ALICE, READER))?.text).toBe('Needs Alice')
    expect(statusNote('running', needsLabel(ALICE, READER))?.text).toBe('Running')
  })

  test('a permission and a limit on a teammate\'s turn say whose it is', () => {
    expect(othersTurnTitle('Run a shell command', 'Alice\'s turn')).toBe('Alice\'s turn asks to run a shell command')
    expect(othersTurnTitle('Run a shell command', null)).toBe('Run a shell command')
    expect(limitTitle('five-hour', ALICE, READER)).toBe('Alice\'s seat reached the five-hour limit')
    expect(limitTitle('', ALICE, SELF_ALICE)).toBe('Reached the usage limit')
  })

  test('the composer names a teammate\'s turn it would steer, and the keys only where there are keys', () => {
    // The room's active turn carries its author as a `User` (plans/012 §1).
    const turn: SessionActiveTurn = { author: ALICE, provider: 'codex' }
    expect(steerPlaceholder(otherPerson(turn.author, READER), true)).toBe('Enter to steer Alice\'s turn · ⌥Enter to queue next')
    expect(steerPlaceholder(otherPerson(turn.author, READER), false)).toBe('Send to steer Alice\'s turn...')
    expect(steerPlaceholder(otherPerson(turn.author, SELF_ALICE), true)).toBe('Enter to steer now · ⌥Enter to queue next')
  })

  test('a decision reads as what was chosen, and a plan card states only its state', () => {
    expect(permissionDecisionNotice('approved', 'Bash')).toBe('approved Bash')
    expect(permissionDecisionNotice('approved_for_session', 'Bash')).toBe('approved Bash for this session')
    expect(permissionDecisionNotice('denied', 'Edit')).toBe('denied Edit')
    // Who decided is a `permission_decided` activity beside the card (plans/012 §5).
    expect(planTypeLabel('rejected')).toBe('plan rejected')
    expect(planTypeLabel('accepted')).toBe('plan accepted')
    expect(planTypeLabel('pending')).toBe('plan')
  })
})

describe('the organization refusal card', () => {
  test('a turn with no organization offers the choice to a signed-in person and sign-in to anyone else', () => {
    expect(turnRefusalCopy('ORGANIZATION_REQUIRED', { signedIn: true, activeOrganization: null }).action).toBe('choose-organization')
    expect(turnRefusalCopy('ORGANIZATION_REQUIRED', { signedIn: false, activeOrganization: null }).action).toBe('sign-in')
    expect(turnRefusalCopy('ORGANIZATION_AUTHORITY_MISSING', { signedIn: true, activeOrganization: 'Acme' }).action).toBe('sign-in')
  })

  test('the title names the organization the turn needs', () => {
    expect(turnRefusalCopy('ORGANIZATION_ACCESS_REFUSED', { signedIn: true, activeOrganization: 'Acme' }).title).toBe('Acme refused this turn')
    expect(turnRefusalCopy('ORGANIZATION_NOT_ALLOWED', { signedIn: true, activeOrganization: 'Acme' }).title).toBe('This machine does not run work for Acme')
  })
})

describe('a rename', () => {
  function sessions() {
    return {
      open: { id: 'session-1', run: { serverId: 'host-1', taskServerId: 'host-1' }, agentSessionId: 'agent-1', title: 'Old', titleCustom: false, messages: [] } as unknown as Session,
    }
  }

  test('a rename changes the name and writes nothing into the conversation: who renamed it is a `renamed` activity (plans/012 §5)', () => {
    const renamed = sessions()
    applySessionTitleChange(renamed, 'host-1', { sessionId: 'session-1', title: 'Fix login', source: 'manual' })
    expect(renamed.open).toMatchObject({ title: 'Fix login', titleCustom: true, messages: [] })
  })
})
