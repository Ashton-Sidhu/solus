import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { parseJsonlLine } from '@solus/server/agents/claude/claude-session-helpers'
import { projectSessionHistory } from '@solus/server/server/result-projection'
import { deferSessionToolInputs } from '@solus/server/server/session-tool-inputs'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

const {
  loadRestoredSessionTranscript,
  loadSessionTranscript,
  materializeSessionTranscript,
  RESTORED_TRANSCRIPT_LIMIT,
} = await import('@solus/workspace-ui/contexts/workspace/session-transcript')

afterEach(() => connections.reset())

describe('session transcript rehydration', () => {
  for (const provider of ['claude-code', 'codex'] as const) {
    test(`${provider} restores artifact updates, identities and failed calls from mobile history`, () => {
      const prefix = provider === 'claude-code' ? 'mcp__solus__' : ''
      const history: SessionLoadMessage[] = []
      function call(toolId: string, name: string, input: { html?: string; work_id?: string; content?: string }, output: string, failed = false) {
        const tool: SessionLoadMessage = { role: 'tool', toolId, toolName: `${prefix}${name}`, toolInput: JSON.stringify(input), content: '', timestamp: history.length + 1 }
        history.push(tool)
        if (provider === 'codex') {
          tool.content = output
          tool.toolStatus = failed ? 'error' : 'completed'
        } else history.push({ role: 'tool_result', toolResultForId: toolId, content: output, toolResultIsError: failed, timestamp: history.length + 1 })
      }
      call('create', 'render_artifact', { html: '<p>Original</p>' }, 'Rendered "Same title" in the conversation and saved it as an artifact (id: work-a).')
      call('other', 'render_artifact', { html: '<p>Separate</p>' }, 'Rendered "Same title" in the conversation and saved it as an artifact (id: work-b).')
      call('edit', 'update_work', { work_id: 'work-a', content: '<p>Revised</p>' }, 'Updated "Renamed" (artifact, id: work-a).')
      call('failed', 'update_work', { work_id: 'work-a', content: '<p>Failed</p>' }, 'Work tool error: save failed', true)
      call('document', 'update_work', { work_id: 'doc', content: 'Document' }, 'Updated "Document".')
      history.push({ role: 'tool', toolId: 'interrupted', toolName: `${prefix}update_work`, toolInput: JSON.stringify({ work_id: 'work-a', content: '<p>Incomplete</p>' }), content: '', timestamp: 20 })
      connections.registerPrimary('transcript-host', {})
      const ctx = {
        apiForSession: () => connections.apiFor('transcript-host'),
        worksStore: { get: () => undefined },
      } as unknown as WorkspaceContext
      const transcript = materializeSessionTranscript(ctx, {
        sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider,
        ctx: { session: { sessionId: 'tab' } } as IpcContext,
      }, deferSessionToolInputs(projectSessionHistory(history)))
      const artifacts = transcript.messages.filter((message) => message.artifact)
      expect(artifacts.map((message) => message.artifact?.html)).toEqual(['<p>Original</p>', '<p>Separate</p>', '<p>Revised</p>'])
      expect(artifacts.map((message) => message.workRef?.workId)).toEqual(['work-a', 'work-b', 'work-a'])
      expect(artifacts.map((message) => message.workRef?.title)).toEqual(['Same title', 'Same title', 'Renamed'])
    })
  }
  test('folds the latest thought before a tool call onto it as a one-line preview', () => {
    // WHY: a reloaded turn must show the same "Thought" line the live turn
    // showed. Reasoning with no readable text keeps the earlier thought, and a
    // turn with no reasoning keeps the plain label.
    connections.registerPrimary('transcript-host', {})
    const ctx = { apiForSession: () => connections.apiFor('transcript-host') } as unknown as WorkspaceContext
    const transcript = materializeSessionTranscript(ctx, {
      sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider: 'claude-code',
      ctx: { session: { sessionId: 'tab' } } as IpcContext,
    }, [
      { role: 'user', content: 'fix the rule', timestamp: 1 },
      { role: 'reasoning', content: 'First idea', timestamp: 2 },
      { role: 'reasoning', content: '**Reading the stylesheet**\n\nThe rule is unlayered.', timestamp: 3 },
      { role: 'reasoning', content: '   ', timestamp: 4 },
      { role: 'tool', content: '', toolName: 'Read', toolId: 'read', toolInput: '{}', timestamp: 6 },
      { role: 'tool', content: '', toolName: 'Edit', toolId: 'edit', toolInput: '{}', timestamp: 7 },
    ])
    const tools = transcript.messages.filter((message) => message.role === 'tool')
    expect(tools.map((tool) => tool.thinkingPreview)).toEqual(['Reading the stylesheet', undefined])
    expect(tools[0].thinkingMs).toBe(4)
  })

  test('late subagent activity follows its owning call across disjoint pages', async () => {
    connections.registerPrimary('transcript-host', {
      loadSessionPage: async (request) => request.before ? {
        messages: [
          { role: 'user', content: 'start', timestamp: 1 },
          { role: 'tool', content: '', toolName: 'Agent', toolId: 'parent', isSubagent: true, timestamp: 2 },
        ], before: null,
      } : {
        messages: [
          { role: 'user', content: 'continue while the agent works', timestamp: 3 },
          { role: 'assistant', content: 'nested reply', parentToolUseId: 'parent', timestamp: 4 },
          { role: 'tool_result', content: '', report: 'finished', toolResultForId: 'parent', status: 'ok', timestamp: 5 },
        ], before: 'older',
      },
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext
    const args = {
      sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider: 'claude-code' as const,
      ctx: { session: { sessionId: 'tab' } } as IpcContext,
    }
    const recent = await loadRestoredSessionTranscript(ctx, args)
    expect(recent.messages.map((message) => message.content)).toEqual(['continue while the agent works'])
    expect(recent.pendingMessages).toHaveLength(2)
    const older = await loadRestoredSessionTranscript(ctx, {
      ...args, before: recent.before!, pendingMessages: recent.pendingMessages,
    })
    const parent = older.messages.find((message) => message.toolId === 'parent')
    expect(parent?.report).toBe('finished')
    expect(parent?.toolStatus).toBe('completed')
    expect(parent?.subMessages?.map((message) => message.content)).toEqual(['nested reply'])
    expect(older.pendingMessages).toEqual([])
  })

  test('a short cursor page still exposes older history and forwards the cursor', async () => {
    const loadSessionPage = mock(async (_request: SessionHistoryPageRequest) => ({
      messages: [{ role: 'user', content: 'older turn', timestamp: 1 }], before: 'next-page',
    }))
    connections.registerPrimary('transcript-host', { loadSessionPage })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext
    const transcript = await loadRestoredSessionTranscript(ctx, {
      sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider: 'codex',
      ctx: { session: { sessionId: 'tab' } } as IpcContext, before: 'older-page',
    })
    expect(loadSessionPage.mock.calls[0]?.[0]).toMatchObject({ before: 'older-page', limit: 200 })
    expect(transcript.truncated).toBe(true)
    expect(transcript.before).toBe('next-page')
  })

  test('consumes an early history read without issuing a duplicate RPC', async () => {
    const loadSession = mock(async () => [])
    connections.registerPrimary('transcript-host', { loadSession })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext
    const transcript = await loadRestoredSessionTranscript(ctx, {
      sessionId: 'stable-session', loadPath: '/repo', displayCwd: '/repo', provider: 'codex',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
      history: Promise.resolve([{ role: 'tool', content: '', toolName: 'Read', toolId: 'read-1', toolInputKey: 'input-key', timestamp: 1 }]),
    })
    expect(loadSession).not.toHaveBeenCalled()
    expect(transcript.messages.find((message) => message.toolId === 'read-1')?.historyToolInput).toMatchObject({
      serverId: 'transcript-host', sessionId: 'stable-session', provider: 'codex', key: 'input-key',
    })
  })

  test('mobile history keeps the source needed to fetch inputs on summary expansion', async () => {
    const options: Array<{ deferToolInputs?: boolean } | undefined> = []
    connections.registerPrimary('transcript-host', {
      loadSession: async (_sessionId, _projectPath, _ctx, _provider, _limit, option) => {
        options.push(option)
        return [{ role: 'tool', content: '', toolName: 'Read', toolId: 'read-1', toolInputKey: 'input-key', timestamp: 1 }]
      },
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      deferHistoryToolInputs: true,
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'saved-session', loadPath: '/repo', displayCwd: '/repo', provider: 'codex',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    expect(options).toEqual([{ deferToolInputs: true }])
    expect(transcript.messages.find((message) => message.toolId === 'read-1')).toMatchObject({
      toolInput: undefined,
      historyToolInput: {
        serverId: 'transcript-host', sessionId: 'saved-session', projectPath: '/repo', provider: 'codex', key: 'input-key',
      },
    })
  })

  test('rebuilds a rendered artifact with the work it was saved as', async () => {
    // WHY: identity survives renames and same-title artifacts. It comes from
    // the successful receipt, even before the works store has loaded.
    const html = '<!doctype html><html><head><title>Latency</title></head><body></body></html>'
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{
        role: 'tool' as const,
        content: '',
        toolName: 'mcp__solus__render_artifact',
        toolId: 'artifact-1',
        toolInput: JSON.stringify({ html }),
        artifactWorkRef: { workId: 'w-art', title: 'Latency' },
        timestamp: 1,
      }],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
      worksStore: {
        works: {
          'w-art': { id: 'w-art', title: 'Latency', type: 'artifact', sessionIds: ['session-1'] },
        },
      },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'claude-code',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    expect(transcript.messages[1]).toMatchObject({
      artifact: { kind: 'html', html },
      workRef: { workId: 'w-art', title: 'Latency', workType: 'artifact' },
    })
  })

  test('rebuilds provider-history images as user-message attachments', async () => {
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{
        role: 'user' as const,
        content: 'Please fix this',
        imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' }],
        timestamp: 1,
      }],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'claude-code',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    expect(transcript.messages[0]).toMatchObject({
      role: 'user',
      content: 'Please fix this',
      attachments: [{
        name: '',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,cG5n',
        type: 'image',
      }],
    })
  })

  test('keeps both model labels on a restored handoff divider', async () => {
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{
        role: 'system' as const,
        content: 'Switched to Codex',
        agentChangedTo: 'Codex',
        agentChangedFromModel: 'Sonnet 5',
        agentChangedToModel: 'Gpt 5.4',
        agentChangedFromProvider: 'claude-code' as const,
        agentChangedToProvider: 'codex' as const,
        timestamp: 2,
      }],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'codex',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    // WHY: reloading a session must not reduce a model-to-model boundary back
    // to the older provider-only label.
    expect(transcript.messages[0]).toMatchObject({
      agentChangedFromModel: 'Sonnet 5',
      agentChangedToModel: 'Gpt 5.4',
      agentChangedFromProvider: 'claude-code',
      agentChangedToProvider: 'codex',
    })
  })

  test('keeps projected nested tool status without restoring its output', async () => {
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [
        {
          role: 'tool' as const,
          content: '',
          toolName: 'Agent',
          toolId: 'agent-1',
          toolInput: '{}',
          isSubagent: true,
          timestamp: 1,
        },
        {
          role: 'tool' as const,
          content: '',
          toolName: 'Bash',
          toolId: 'bash-1',
          toolInput: '{"command":"false"}',
          parentToolUseId: 'agent-1',
          status: 'error' as const,
          errorHead: 'command failed',
          contentBytes: 4096,
          timestamp: 2,
        },
      ],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'claude-code',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    const child = transcript.messages[0]?.subMessages?.[0]
    expect(child).toMatchObject({
      content: '',
      toolStatus: 'error',
      errorHead: 'command failed',
      contentBytes: 4096,
    })
  })

  test('preserves the full transcript when startup does not request a window', async () => {
    const history = Array.from({ length: 150 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      timestamp: index,
    }))
    const limits: Array<number | undefined> = []
    connections.registerPrimary('transcript-host', {
      loadSession: async (
        _sessionId: string,
        _projectPath: string,
        _ctx: IpcContext,
        _provider: string,
        limit?: number,
      ) => {
        limits.push(limit)
        return limit ? history.slice(-limit) : history
      },
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'codex',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    })

    expect(limits).toEqual([undefined])
    expect(transcript.messages).toHaveLength(150)
    expect(transcript.messages[0]?.content).toBe('message-0')
    expect(transcript.messages.at(-1)?.content).toBe('message-149')
    expect(transcript.truncated).toBe(false)
  })

  test('marks restored transcript windows for on-demand expansion', async () => {
    const history = Array.from({ length: RESTORED_TRANSCRIPT_LIMIT + 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      timestamp: index,
    }))
    connections.registerPrimary('transcript-host', {
      loadSession: async (
        _sessionId: string,
        _projectPath: string,
        _ctx: IpcContext,
        _provider: string,
        limit?: number,
      ) => limit ? history.slice(-limit) : history,
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext

    const transcript = await loadSessionTranscript(ctx, {
      sessionId: 'session-1',
      loadPath: '/repo',
      displayCwd: '/repo',
      provider: 'codex',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
      limit: RESTORED_TRANSCRIPT_LIMIT,
    })

    expect(transcript.messages).toHaveLength(RESTORED_TRANSCRIPT_LIMIT)
    expect(transcript.truncated).toBe(true)
  })

  test('applies the restore window to every transcript in a provider handoff', async () => {
    const limits: Array<{ sessionId: string; limit?: number }> = []
    const history = Array.from({ length: RESTORED_TRANSCRIPT_LIMIT + 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
      timestamp: index,
    }))
    connections.registerPrimary('transcript-host', {
      loadSession: async (
        sessionId: string,
        _projectPath: string,
        _ctx: IpcContext,
        _provider: string,
        limit?: number,
      ) => {
        limits.push({ sessionId, limit })
        return limit ? history.slice(-limit) : history
      },
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
    } as unknown as WorkspaceContext
    const common = {
      loadPath: '/repo',
      displayCwd: '/repo',
      ctx: { session: { sessionId: 'tab-1' } } as IpcContext,
    }

    const predecessor = await loadRestoredSessionTranscript(ctx, {
      ...common,
      sessionId: 'predecessor',
      provider: 'claude-code',
    })
    const current = await loadRestoredSessionTranscript(ctx, {
      ...common,
      sessionId: 'current',
      provider: 'codex',
    })

    expect(limits).toEqual([
      { sessionId: 'predecessor', limit: RESTORED_TRANSCRIPT_LIMIT },
      { sessionId: 'current', limit: RESTORED_TRANSCRIPT_LIMIT },
    ])
    expect(predecessor.messages).toHaveLength(RESTORED_TRANSCRIPT_LIMIT)
    expect(current.messages).toHaveLength(RESTORED_TRANSCRIPT_LIMIT)
    expect(predecessor.truncated).toBe(true)
    expect(current.truncated).toBe(true)
  })
})


test('first-render transcript conversion does not wait for automation metadata', () => {
  connections.registerPrimary('transcript-host', {})
  const loadAll = mock(() => new Promise<void>(() => {}))
  const ctx = {
    apiForSession: () => connections.apiFor('transcript-host'),
    automationsStore: { loaded: false, items: [], loadAll },
  } as unknown as WorkspaceContext
  const transcript = materializeSessionTranscript(ctx, {
    sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider: 'codex',
    ctx: { session: { sessionId: 'tab' } } as IpcContext,
  }, {
    messages: [
      { role: 'user', content: 'show this immediately', timestamp: 1 },
      { role: 'tool', content: '', toolName: 'create_automation', toolInput: '{"name":"Later"}', timestamp: 2 },
    ], before: null,
  })
  expect(transcript.messages[0].content).toBe('show this immediately')
  expect(loadAll).not.toHaveBeenCalled()
})

test('Claude MCP array receipts restore both versions and keep failed revisions out', () => {
  const history: SessionLoadMessage[] = []
  for (const [toolId, name, input, receipt, failed] of [
    ['create', 'render_artifact', { html: '<p>One</p>' }, 'Rendered "One" in the conversation and saved it as an artifact (id: work).', false],
    ['update', 'update_work', { work_id: 'work', content: '<p>Two</p>' }, 'Updated "Two" (artifact, id: work).', false],
    ['failed', 'update_work', { work_id: 'work', content: '<p>Failed</p>' }, 'Save failed', true],
  ] as const) {
    const result = [{ type: 'text', text: receipt }]
    for (const row of [
      { type: 'assistant', timestamp: 1, message: { content: [{ type: 'tool_use', id: toolId, name: `mcp__solus__${name}`, input }] } },
      { type: 'user', timestamp: 2, toolUseResult: result, message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: result, is_error: failed }] } },
    ]) {
      const parsed = parseJsonlLine(JSON.stringify(row))
      expect(parsed).not.toBeNull()
      if (parsed) history.push(parsed)
    }
  }
  connections.registerPrimary('transcript-host', {})
  const ctx = { apiForSession: () => connections.apiFor('transcript-host'), worksStore: { get: () => undefined } } as unknown as WorkspaceContext
  const transcript = materializeSessionTranscript(ctx, {
    sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider: 'claude-code',
    ctx: { session: { sessionId: 'tab' } } as IpcContext,
  }, deferSessionToolInputs(projectSessionHistory(history)))
  expect(transcript.messages.filter(m => m.artifact).map(m => [m.artifact?.html, m.workRef?.workId])).toEqual([
    ['<p>One</p>', 'work'], ['<p>Two</p>', 'work'],
  ])
})
