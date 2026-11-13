import { describe, expect, test } from 'bun:test'
import {
  activityDurationMs,
  describeBackgroundWait,
  getToolDescription,
  getToolDescriptionFromParsed,
  liveActivityLabel,
  parseToolInput,
  liveToolStep,
  settledBackgroundWait,
  toolActivityTarget,
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
    return [{ kind: 'tool-group', messages, steps: messages }]
  }

  test('names the running command instead of claiming the session is planning', () => {
    // WHY: the session sat here for four minutes with a poll loop in flight and
    // told the user it was planning the next step. The wait is the fact.
    // The intent and the wait are one sentence, not a status and a caption.
    expect(describeBackgroundWait(turn(backgroundBash()))).toEqual({
      label: 'Polling until www.solus.sh resolves and serves 200 in the background…',
      command: '',
    })
  })

  test('quotes an intent that does not start with a verb it can inflect', () => {
    // WHY: guessing a verb turns "Dev server for the client" into "Deving server".
    const wait = describeBackgroundWait(
      turn(backgroundBash({ toolInput: JSON.stringify({ command: 'bun dev', description: 'Dev server for the client' }) })),
    )
    expect(wait?.label).toBe('Running “Dev server for the client” in the background…')
  })

  test('a turn that ended in the background state still names the work', () => {
    // WHY: once the turn settles into `background` it folds into its summary
    // row. That row must say the task still runs — with the task's own intent
    // when this turn launched it, and in general words when an earlier turn did.
    expect(settledBackgroundWait(turn(backgroundBash()))).toEqual({
      label: 'Polling until www.solus.sh resolves and serves 200 in the background',
      command: '',
    })
    expect(settledBackgroundWait([])).toEqual({ label: 'Running in the background', command: '' })
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
      ...turn(backgroundBash()),
      { kind: 'assistant', message: { id: 'a1', role: 'assistant', content: 'polling', timestamp: LAUNCHED_AT + 1 } as Message },
      ...turn(later),
    ]
    expect(describeBackgroundWait(items)?.label).toBe('Polling until www.solus.sh resolves and serves 200 in the background…')
  })

  test('counts rather than picking a winner when several are in flight', () => {
    const wait = describeBackgroundWait(
      turn(backgroundBash(), backgroundBash({ id: 'bash-2', backgroundTaskId: 'bxyz' })),
    )
    expect(wait).toEqual({ label: 'Running 2 commands in the background…', command: '' })
  })

  test('falls back to the command when the provider states no intent', () => {
    // WHY: Bash `description` is model-authored and optional, and Codex has no
    // equivalent field at all. The command is the best the row can honestly say.
    const wait = describeBackgroundWait(
      turn(backgroundBash({ toolInput: JSON.stringify({ command: POLL_COMMAND }) })),
    )
    // The command follows the label, so the label does not end in an ellipsis.
    expect(wait).toEqual({ label: 'Running in the background', command: POLL_COMMAND })
  })

  function subagent(overrides: Partial<Message> = {}): Message {
    return {
      id: 'agent-1',
      role: 'tool',
      content: '',
      toolName: 'Agent',
      toolStatus: 'running',
      timestamp: LAUNCHED_AT,
      toolInput: JSON.stringify({ description: 'Study Solus diff panel', prompt: 'Find how…' }),
      subMessages: [],
      ...overrides,
    } as Message
  }

  test('names a running sub-agent whose card is above the fold', () => {
    // WHY: the parent keeps writing below the sub-agent card. Without this the
    // tail says nothing and the session looks finished while an agent works.
    const items: GroupedItem[] = [
      { kind: 'subagent-group', messages: [subagent(), subagent({ id: 'agent-2', toolStatus: 'completed' })] },
      { kind: 'assistant', message: { id: 'a1', role: 'assistant', content: 'One report is in.', timestamp: LAUNCHED_AT + 1 } as Message },
    ]
    expect(describeBackgroundWait(items)).toEqual({ label: 'Waiting on a subagent to study Solus diff panel…', command: '' })
  })

  test('counts sub-agents when several are running, ahead of any command', () => {
    const items: GroupedItem[] = [
      ...turn(backgroundBash()),
      { kind: 'subagent-group', messages: [subagent(), subagent({ id: 'agent-2' })] },
    ]
    expect(describeBackgroundWait(items)).toEqual({ label: 'Waiting on 2 subagents…', command: '' })
  })

  test('says nothing once every sub-agent has reported', () => {
    const items: GroupedItem[] = [{ kind: 'subagent-group', messages: [subagent({ toolStatus: 'completed' })] }]
    expect(describeBackgroundWait(items)).toBeNull()
  })

  function watchedPeer(reply?: string): Message {
    return {
      id: 'peer-card',
      role: 'assistant',
      content: '',
      timestamp: LAUNCHED_AT,
      agentConversationRef: {
        agentSessionId: '48964886-a22b-4cda-96f6-b416ed8f32bf',
        provider: 'claude-code',
        title: 'Worker',
        cwd: '',
        origin: 'watched',
        exchanges: [{
          messageId: 'watch-1',
          index: 1,
          prompt: '',
          dispatchedAt: LAUNCHED_AT,
          status: reply === undefined ? 'dispatched' : 'done',
          reply,
        }],
      },
    } as Message
  }

  test('names the watched session when the turn ended in prose', () => {
    // WHY: after wait_for_session the agent writes a closing line and the host
    // holds the turn running until the report lands. The row under that prose
    // said "Planning the next step…" while nothing was being planned.
    const items: GroupedItem[] = [
      ...turn(backgroundBash({ id: 'read', toolName: 'mcp__solus__read_session', backgroundTaskId: undefined })),
      { kind: 'agent-conversation-group', messages: [watchedPeer()] },
      { kind: 'assistant', message: { id: 'a1', role: 'assistant', content: 'I will start when it reports.', timestamp: LAUNCHED_AT + 1 } as Message },
    ]
    expect(describeBackgroundWait(items)).toEqual({ label: 'Waiting on Claude Code…', command: '' })
  })

  test('puts another session ahead of a sub-agent, and drops it once it replies', () => {
    const running: GroupedItem[] = [
      { kind: 'subagent-group', messages: [subagent()] },
      { kind: 'agent-conversation-group', messages: [watchedPeer()] },
    ]
    expect(describeBackgroundWait(running)?.label).toBe('Waiting on Claude Code…')

    const replied: GroupedItem[] = [{ kind: 'agent-conversation-group', messages: [watchedPeer('Done.')] }]
    expect(describeBackgroundWait(replied)).toBeNull()
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
    expect(activityDurationMs([message], null)).toBe(275_000)
  })

  test('runs to the live clock while the group is still running', () => {
    // WHY: the rail only moved when a tool completed, so a long running
    // command sat beside a frozen time — or no time at all.
    const done = { id: 'read-1', role: 'tool', content: '', toolName: 'Read', timestamp: 1_000, toolCompletedAt: 2_000 } as Message
    const running = { id: 'bash-1', role: 'tool', content: '', toolName: 'Bash', timestamp: 2_500, toolStatus: 'running' } as Message
    expect(activityDurationMs([done, running], null)).toBe(1_000)
    expect(activityDurationMs([done, running], 9_000)).toBe(8_000)
    expect(activityDurationMs([running], 9_000)).toBe(6_500)
  })
})

describe('toolActivityTarget', () => {
  test('waits for file tool input, then names the file', () => {
    // WHY: Claude announces the tool before it sends the input. The live row
    // must not repeat the tool name, and must name the file when it arrives.
    for (const toolName of ['Read', 'Edit', 'Write']) {
      expect(toolActivityTarget(toolName, '')).toBe('')
      expect(toolActivityTarget(toolName, JSON.stringify({ file_path: '/repo/src/App.svelte' })))
        .toBe('/repo/src/App.svelte')
    }
    expect(toolActivityTarget('NotebookRead', JSON.stringify({ notebook_path: '/repo/notes.ipynb' })))
      .toBe('/repo/notes.ipynb')
    expect(toolActivityTarget('NotebookEdit', JSON.stringify({ notebook_path: '/repo/notes.ipynb' })))
      .toBe('/repo/notes.ipynb')
  })
})

describe('liveToolStep', () => {
  const input = (fields: object) => JSON.stringify(fields)

  test('says the intent of the agent for a command as one sentence', () => {
    // WHY: "Running  for i in $(seq 1 30)…" says how, not why. The intent the
    // agent stated reads as a sentence; the raw command is the fallback.
    expect(liveToolStep('Bash', input({ command: 'bun test tests/unit', description: 'Run focused unit tests' })))
      .toEqual({ label: 'Running focused unit tests', target: '' })
    expect(liveToolStep('Bash', input({ command: 'git status', description: 'Show working tree status.' })))
      .toEqual({ label: 'Showing working tree status', target: '' })
    expect(liveToolStep('Bash', input({ command: 'bun test' }))).toEqual({ label: 'Running', target: 'bun test' })
    expect(liveToolStep('Bash')).toEqual({ label: 'Running a command', target: '' })
  })

  test('names a file by its name, not its whole path', () => {
    // WHY: a long absolute path truncates to its root, which says nothing.
    expect(liveToolStep('Read', input({ file_path: '/repo/src/App.svelte' }))).toEqual({ label: 'Reading', target: 'App.svelte' })
    expect(liveToolStep('Write', input({ file_path: '/repo/src/App.svelte' }))).toEqual({ label: 'Writing', target: 'App.svelte' })
    expect(liveToolStep('Edit', input({ file_path: '/repo/a.ts' })).label).toBe('Editing')
    expect(liveToolStep('Read', '')).toEqual({ label: 'Reading', target: '' })
  })

  test('reads searches and other tools as sentences', () => {
    expect(liveToolStep('Grep', input({ pattern: 'TODO' }))).toEqual({ label: 'Searching for', target: 'TODO' })
    expect(liveToolStep('WebSearch', input({ query: 'svelte 5 runes' })).label).toBe('Searching the web for “svelte 5 runes”')
    expect(liveToolStep('mcp__linear__create_issue', input({ title: 'x' })).label).toBe('Creating issue')
    expect(liveToolStep('mcp__acme__gizmo', '{}').label).toBe('Using gizmo')
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

  // WHY: one batch call links a whole stack. A row of six URLs is unreadable;
  // the count is what the reader scans for.
  test('names a batch link or unlink by its pull requests', () => {
    const urls = [1, 2, 3, 4, 5, 6].map((number) => `https://github.com/acme/app/pull/${number}`)
    expect(getToolDescription('mcp__solus__link', JSON.stringify({ kind: 'pr', target_ids: urls }))).toBe('Link 6 pull requests')
    expect(getToolDescription('unlink', JSON.stringify({ kind: 'pr', states: ['closed', 'merged'] }))).toBe('Unlink closed and merged pull requests')
    expect(getToolDescription('link', JSON.stringify({ kind: 'pr', target_id: urls[0] }), { truncate: false })).toBe(`link: {"kind":"pr","target_id":"${urls[0]}"}`)
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
    expect(getToolDescription('search_sessions', '{}', { truncate: false })).toBe('search_sessions')
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
