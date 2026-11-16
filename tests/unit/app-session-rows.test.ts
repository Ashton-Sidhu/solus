import { describe, expect, test } from 'bun:test'
import type { AppSessionLink } from '@solus/contracts/apps'
import type { Message } from '@solus/contracts/types'
import {
  adjacentAppSession,
  appSessionByline,
  appSessionGroups,
  lastTurnMessages,
  selectedAppSession,
} from '@solus/workspace-ui/components/app/manage/lib/app-sessions'
import { appSessionReply, appSessionRun, appSessionStart } from '@solus/workspace-ui/components/app/manage/lib/app-session-actions'

const HOUR = 3_600_000
const NOW = 100 * HOUR

function link(sessionId: string, patch: Partial<AppSessionLink> = {}): AppSessionLink {
  return { sessionId, title: sessionId, linkedAt: NOW - 2 * HOUR, provider: 'codex', status: 'idle', lastActivityAt: NOW - HOUR, ...patch }
}

describe('the list of an app’s Sessions section', () => {
  test('sessions stand in Working, Done, and Stopped, each group the most recently active first', () => {
    // WHY: the owner looks for what still runs first; a stopped session must not read as finished work.
    const groups = appSessionGroups([
      link('old-done', { lastActivityAt: NOW - 5 * HOUR }),
      link('stopped', { status: 'interrupted' }),
      link('new-done', { lastActivityAt: NOW - 10_000 }),
      link('running', { status: 'running' }),
    ], NOW)
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.sessionId)])).toEqual([
      ['Working', ['running']],
      ['Done', ['new-done', 'old-done']],
      ['Stopped', ['stopped']],
    ])
  })

  test('a session the host keeps no record of is Stopped and claims no provider', () => {
    // WHY: a lying status is a correctness bug; with no record the session cannot run.
    const [group] = appSessionGroups([link('gone', { title: null, provider: null, status: null, lastActivityAt: null })], NOW)
    expect(group?.label).toBe('Stopped')
    expect(group?.rows[0]).toMatchObject({ title: 'Untitled session', provider: null, detail: 'Linked 2 hr ago', time: '2h' })
  })

  test('the selection stays on the chosen session while it is linked, and falls to the first row when it goes', () => {
    // WHY: Unlink of the open session must not leave the card on a session the list no longer has.
    const groups = appSessionGroups([link('a', { status: 'running' }), link('b')], NOW)
    expect(selectedAppSession(groups, 'b')?.sessionId).toBe('b')
    expect(selectedAppSession(groups, 'unlinked')?.sessionId).toBe('a')
    expect(selectedAppSession([], null)).toBeNull()
  })

  test('the arrow keys move along the rows across the groups and stop at the ends', () => {
    const groups = appSessionGroups([link('a', { status: 'running' }), link('b'), link('c', { status: 'interrupted' })], NOW)
    expect(adjacentAppSession(groups, 'a', 1)).toBe('b')
    expect(adjacentAppSession(groups, 'b', 1)).toBe('c')
    expect(adjacentAppSession(groups, 'c', 1)).toBe('c')
    expect(adjacentAppSession(groups, 'a', -1)).toBe('a')
  })

  test('the card names the agent, how the session stands, and when it was last active', () => {
    expect(appSessionByline(link('a', { provider: 'claude-code', status: 'running', lastActivityAt: NOW - 20 * 60_000 }), NOW)).toBe('Claude Code · working · active 20 min ago')
  })
})

describe('the card of an app’s Sessions section', () => {
  const message = (role: Message['role'], content: string) => ({ id: content, role, content, timestamp: 0 }) as Message

  test('the card shows the last turn: the newest prompt and everything after it', () => {
    // WHY: the card is a summary; the whole transcript opens in its own tab.
    const messages = [message('user', 'one'), message('assistant', 'first answer'), message('user', 'two'), message('assistant', 'second answer'), message('tool', 'edit')]
    expect(lastTurnMessages(messages).map((entry) => entry.content)).toEqual(['two', 'second answer', 'edit'])
    expect(lastTurnMessages([message('assistant', 'only')]).map((entry) => entry.content)).toEqual(['only'])
  })

  test('a reply waits for the turn that runs, and carries its own prompt id', () => {
    // WHY: a reply must never cut into the agent's work; the queue keeps it for the next turn.
    expect(appSessionReply('s1', '  Post it to Slack too.  ', 'p1')).toEqual({ sessionId: 's1', prompt: 'Post it to Slack too.', delivery: 'queue', promptId: 'p1' })
  })

  test('a new session runs in the app’s project with the person’s default agent and model', () => {
    // WHY: the session is about the app, so it must start where the app's source is, as any new tab would.
    const modelConfig = { modelId: 'gpt-5', reasoningEffort: 'medium' as const, contextWindow: null, fastMode: false }
    const run = appSessionRun('codex', () => modelConfig, {})
    expect(appSessionStart({ name: 'Release Radar', project: '/work/radar' }, 'Add a digest', run)).toMatchObject({
      prompt: 'Add a digest', provider: 'codex', modelId: 'gpt-5', reasoningEffort: 'medium', cwd: '/work/radar',
    })
    // An app with no known project starts in a new chat folder; an agent this client does not know is Claude Code.
    expect(appSessionStart({ name: 'Radar', project: null }, 'x', appSessionRun('someone-else', () => modelConfig, {})).cwd).toBe('solus:new-chat')
    expect(appSessionRun('someone-else', () => modelConfig, {}).provider).toBe('claude-code')
  })
})
