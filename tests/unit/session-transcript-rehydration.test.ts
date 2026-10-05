import type { Activity } from '@solus/contracts/activity'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionHistoryPageRequest } from '@solus/contracts/session-history'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { parseJsonlLine } from '@solus/server/execution/agents/claude/claude-session-helpers'
import { codexItemToMessage } from '@solus/server/execution/agents/codex/codex-utils'
import { composeAttachmentContext } from '@solus/workspace-ui/contexts/workspace/prompt-composer'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { deferSessionToolInputs } from '@solus/server/data/sessions/session-tool-inputs'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

const {
  loadRestoredSessionTranscript,
  loadSessionTranscript,
  materializeSessionTranscript,
} = await import('@solus/workspace-ui/contexts/workspace/session-transcript')
const { INITIAL_HISTORY_TURNS } = await import('@solus/client-core/session-history-page')

afterEach(() => connections.reset())

describe('session transcript rehydration', () => {
  test('shared history hydration keeps the durable Q&A row', () => {
    const questionAnswer = { questionId: 'codex-async:session:ask', questions: [{ id: '0', question: 'Which branch?', options: [], multiSelect: false }], answers: { '0': 'main' } }
    const history = projectSessionHistory([{ role: 'system', content: '', timestamp: 10, questionAnswer }])
    connections.registerPrimary('transcript-host', {})
    const ctx = { apiForSession: () => connections.apiFor('transcript-host') } as unknown as WorkspaceContext
    const transcript = materializeSessionTranscript(ctx, {
      sessionId: 'session', loadPath: '/repo', displayCwd: '/repo', provider: 'codex',
      ctx: { session: { sessionId: 'tab' } } as IpcContext,
    }, history)
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0].questionAnswer).toEqual(questionAnswer)
  })

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
      call('document', 'update_work', { work_id: 'doc', content: 'Document' }, 'Updated "Document". New content_version: 4.')
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
      const documents = transcript.messages.filter((message) => message.workRef && !message.artifact)
      expect(documents.map((message) => message.workRef)).toEqual([{ workId: 'doc', title: 'Work', workType: 'doc', contentVersion: 4 }])
    })
  }
  test('keeps the full thoughts before a tool call or prose block on that message', () => {
    // WHY: a reloaded turn must open the same thoughts the live turn showed.
    // Reasoning with no readable text adds nothing, a message with no reasoning
    // before it carries none, and the prose block keeps its own thoughts.
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
      { role: 'reasoning', content: 'Checking the result', timestamp: 8 },
      { role: 'assistant', content: 'Fixed.', timestamp: 9 },
    ])
    const tools = transcript.messages.filter((message) => message.role === 'tool')
    expect(tools.map((tool) => tool.thoughts)).toEqual([
      ['First idea', '**Reading the stylesheet**\n\nThe rule is unlayered.'],
      undefined,
    ])
    expect(tools[0].thinkingMs).toBe(4)
    const answer = transcript.messages.find((message) => message.role === 'assistant')
    expect(answer?.thoughts).toEqual(['Checking the result'])
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
    expect(loadSessionPage.mock.calls[0]?.[0]).toMatchObject({ before: 'older-page', turnLimit: INITIAL_HISTORY_TURNS })
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

  test('a full history read defers tool inputs and keeps the source needed to fetch them on expansion', async () => {
    const options: Array<{ deferToolInputs?: boolean } | undefined> = []
    connections.registerPrimary('transcript-host', {
      loadSession: async (_sessionId, _projectPath, _ctx, _provider, _limit, option) => {
        options.push(option)
        return [{ role: 'tool', content: '', toolName: 'Read', toolId: 'read-1', toolInputKey: 'input-key', timestamp: 1 }]
      },
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
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

  test('rebuilds an html_path render from the revision it saved', async () => {
    // WHY: the stored input of an html_path call is only a path on the host.
    // The full transcript load must fetch the body that call wrote, or the
    // card would come back empty after every reload.
    const html = '<!doctype html><html><head><title>Latency</title></head><body>bundle</body></html>'
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{
        role: 'tool' as const,
        content: '',
        toolName: 'mcp__solus__render_artifact',
        toolId: 'artifact-1',
        toolInput: JSON.stringify({ html_path: 'chart/bundle.html' }),
        artifactWorkRef: { workId: 'w-art', title: 'Latency', contentVersion: 1 },
        timestamp: 1,
      }],
    })
    const ctx = {
      apiForSession: () => connections.apiFor('transcript-host'),
      automationsStore: { loaded: true },
      worksStore: { works: {}, history: { bodyAtVersion: async (workId: string, version: number) => workId === 'w-art' && version === 1 ? html : null } },
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

  test('keeps both models on a restored agent switch', async () => {
    const activity: Activity = {
      id: 'handoff:session-1:1',
      subject: { kind: 'session', id: 'session-1' },
      at: 2,
      by: { kind: 'system' },
      kind: 'agent_switched',
      provider: 'codex',
      model: 'gpt-5.4',
      fromProvider: 'claude-code',
      fromModel: 'Sonnet 5',
    }
    connections.registerPrimary('transcript-host', {
      loadSession: async () => [{ messageId: activity.id, role: 'system' as const, content: '', activity, timestamp: 2 }],
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
    // to the older provider-only label, and the switch is drawn for every
    // reader, the one who made it too.
    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0].activity).toMatchObject({ kind: 'agent_switched', provider: 'codex', model: 'gpt-5.4', fromProvider: 'claude-code', fromModel: 'Sonnet 5' })
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
})
