import { describe, expect, test } from 'bun:test'
import {
  activityDurationMs,
  describeBackgroundWait,
  getToolDescription,
  getToolDescriptionFromParsed,
  liveActivityLabel,
  parseToolInput,
} from '@solus/workspace-ui/components/conversation/lib/activity-summary'
import type { GroupedItem } from '@solus/workspace-ui/components/conversation/lib/turns'
import type { Message } from '@solus/contracts/types'

describe('liveActivityLabel', () => {
  test('keeps fast startup phases visible before the agent begins thinking', () => {
    // WHY: the transport can report running almost immediately. Without a short
    // presentation window, users only ever see the unhelpful thinking fallback.
    expect(liveActivityLabel('Thinking...', 500, false, 'fresh')).toBe('Getting things ready…')
    expect(liveActivityLabel('Thinking...', 2_000, false, 'fresh')).toBe('Connecting to your agent…')
    expect(liveActivityLabel('Thinking...', 4_000, false, 'fresh')).toBe('Thinking it through…')
  })

  test('does not make an established session sound disconnected', () => {
    expect(liveActivityLabel('Resuming...', 500, false, 'follow_up')).toBe('Picking this back up…')
    expect(liveActivityLabel('Thinking...', 2_000, false, 'follow_up')).toBe('Thinking it through…')
  })

  test('acknowledges steering as a change to the active run', () => {
    expect(liveActivityLabel('Thinking...', 500, false, 'steer')).toBe('Adjusting course…')
  })

  test('describes the pause between tool calls as planning the next step', () => {
    expect(liveActivityLabel('Thinking...', 0, true)).toBe('Planning the next step…')
  })
})

describe('describeBackgroundWait', () => {
  const LAUNCHED_AT = 500_000
  const POLL_DESCRIPTION = 'Poll until www.solus.sh resolves and serves 200'
  const POLL_COMMAND = 'for i in $(seq 1 30); do dig +short www.solus.sh; done'

  function backgroundBash(overrides: Partial<Message> = {}): Message {
    return {
      id: 'bash-1',
      role: 'tool',
      content: '',
      toolName: 'Bash',
      // A backgrounded tool answers its call at launch, so it is already
      // completed while the work it started keeps running.
      toolStatus: 'completed',
      toolCompletedAt: LAUNCHED_AT + 40,
      timestamp: LAUNCHED_AT,
      toolInput: JSON.stringify({
        command: POLL_COMMAND,
        description: POLL_DESCRIPTION,
        run_in_background: true,
      }),
      backgroundTaskId: 'b2lrrdn6z',
      ...overrides,
    } as Message
  }

  function turn(...messages: Message[]): GroupedItem[] {
    return [{ kind: 'tool-group', messages }]
  }

  test('names the running command instead of claiming the session is planning', () => {
    // WHY: the session sat here for four minutes with a poll loop in flight and
    // told the user it was planning the next step. The wait is the fact.
    const wait = describeBackgroundWait(turn(backgroundBash()))
    expect(wait?.label).toBe('Running in the background…')
    expect(wait?.target).toBe(POLL_DESCRIPTION)
  })

  test('stops naming the command once its task settles', () => {
    // WHY: the settle is the only signal a backgrounded tool gets that the work
    // stopped — its tool_result landed at launch. Without it the row waits forever.
    const settled = backgroundBash({ backgroundTaskSettledAt: LAUNCHED_AT + 275_000 })
    expect(describeBackgroundWait(turn(settled))).toBeNull()
  })

  test('reads the whole turn, not the group that owns the spinner', () => {
    // WHY: the agent keeps working after backgrounding a command, so the launch
    // sits in an earlier group than the row reporting the wait.
    const later = { id: 'read-1', role: 'tool', content: '', toolName: 'Read', timestamp: LAUNCHED_AT + 9_000 } as Message
    const items: GroupedItem[] = [
      { kind: 'tool-group', messages: [backgroundBash()] },
      { kind: 'assistant', message: { id: 'a1', role: 'assistant', content: 'polling', timestamp: LAUNCHED_AT + 1 } as Message },
      { kind: 'tool-group', messages: [later] },
    ]
    expect(describeBackgroundWait(items)?.target).toBe(POLL_DESCRIPTION)
  })

  test('counts rather than picking a winner when several are in flight', () => {
    const wait = describeBackgroundWait(
      turn(backgroundBash(), backgroundBash({ id: 'bash-2', backgroundTaskId: 'bxyz' })),
    )
    expect(wait?.label).toBe('Running 2 background commands…')
    expect(wait?.target).toBe('')
  })

  test('falls back to the command when the provider states no intent', () => {
    // WHY: Bash `description` is model-authored and optional, and Codex has no
    // equivalent field at all. The command is the best the row can honestly say.
    const wait = describeBackgroundWait(
      turn(backgroundBash({ toolInput: JSON.stringify({ command: POLL_COMMAND }) })),
    )
    expect(wait?.target).toBe(POLL_COMMAND)
  })

  test('leaves a backgrounded sub-agent to the agents that own it', () => {
    // WHY: `waitingOnLabel` names sub-agents. Counting them here would produce
    // two rival descriptions of the same wait.
    const subagent = backgroundBash({ id: 'agent-1', toolName: 'Agent', subagentType: 'Explore' })
    expect(describeBackgroundWait(turn(subagent))).toBeNull()
  })
})

describe('activityDurationMs', () => {
  test('times a backgrounded command by its settle, not its launch', () => {
    // WHY: toolCompletedAt records the spawn, so a four-minute poll reported 0s.
    const message = {
      id: 'bash-1',
      role: 'tool',
      content: '',
      toolName: 'Bash',
      timestamp: 500_000,
      toolCompletedAt: 500_040,
      backgroundTaskId: 'b2lrrdn6z',
      backgroundTaskSettledAt: 775_000,
    } as Message
    expect(activityDurationMs([message])).toBe(275_000)
  })
})

describe('getToolDescription', () => {
  test('shows arguments for bare Codex Solus tools', () => {
    // WHY: repeated Solus calls are indistinguishable in the activity trace
    // when their query or target is hidden.
    expect(
      getToolDescription(
        'search_sessions',
        JSON.stringify({ query: 'host selection', role: 'any', limit: 10 }),
        { truncate: false },
      ),
    ).toBe('search_sessions: {"query":"host selection","role":"any","limit":10}')
  })

  test('shows the same arguments for Claude-prefixed Solus tools', () => {
    expect(
      getToolDescription(
        'mcp__solus__read_session',
        JSON.stringify({ session_id: 'session-123', tail: 20 }),
        { truncate: false },
      ),
    ).toBe('read_session: {"session_id":"session-123","tail":20}')
  })

  test('shows arguments for MCP tools outside Solus', () => {
    // WHY: expanding an MCP call in the tool group must reveal the arguments
    // that distinguish repeated calls to the same external tool.
    expect(
      getToolDescription(
        'mcp__github__get_pull_request',
        JSON.stringify({ owner: 'openai', repo: 'solus', pull_number: 42 }),
        { truncate: false },
      ),
    ).toBe(
      'mcp__github__get_pull_request: {"owner":"openai","repo":"solus","pull_number":42}',
    )
  })

  test('keeps argument-free Solus tools concise', () => {
    expect(getToolDescription('list_sessions', '{}', { truncate: false })).toBe('list_sessions')
  })
})

describe('parseToolInput', () => {
  test('carries the raw JSON that Solus tool descriptions render', () => {
    // WHY: describeSolusTool prints parsed.sourceJson directly. A caller that
    // parses tool input with its own schema loses that field and crashes the
    // transcript on the first Solus tool call (ToolGroupItem regression).
    const parsed = parseToolInput('{"query":"host selection"}')
    expect(parsed?.sourceJson).toBe('{"query":"host selection"}')
    expect(
      getToolDescriptionFromParsed('mcp__solus__search_sessions', parsed!, { truncate: false }),
    ).toBe('search_sessions: {"query":"host selection"}')
  })
})
