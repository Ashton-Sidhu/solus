import { describe, expect, test } from 'bun:test'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { deriveThreadFeedPresentation } from '../../apps/mobile/src/features/threads/thread-feed-presentation'
import { subagentPresentation } from '../../apps/mobile/src/features/threads/agent-card-presentation'
import type { Activity } from '@solus/contracts/activity'

describe('native conversation card state', () => {
  test('a file-backed render names the exact revision instead of showing the latest work', () => {
    const model = TranscriptModel.fromHistory('s', { before: null, messages: [
      { role: 'tool', toolId: 't', toolName: 'render_artifact', toolInput: '{"html_path":"/tmp/render.html"}', content: '', timestamp: 1 },
      { role: 'tool_result', toolResultForId: 't', content: '', status: 'ok', artifactWorkRef: { workId: 'w', title: 'Chart', contentVersion: 3 }, timestamp: 2 },
    ] })
    const item = model.order.map((id) => model.items.get(id)).find((item) => item?.kind === 'artifact')
    expect(item).toMatchObject({ html: '', workId: 'w', contentVersion: 3, title: 'Chart' })
  })

  test('a start_session card rebuilt from history keeps the name its starter gave it', () => {
    // WHY: workers started from one brief share its opening sentence, so the
    // given name is the only thing that tells their rows apart after a reload.
    const model = TranscriptModel.fromHistory('s', { before: null, messages: [
      { role: 'tool', toolId: 't', toolName: 'mcp__solus__start_session', toolInput: '{"prompt":"You are a worker. Fix the server.","title":"Server fixes"}', content: '', timestamp: 1, agentConversationResult: { sessionId: 'child', messageId: 'x' } },
    ] })
    const item = model.order.map((id) => model.items.get(id)).find((item) => item?.kind === 'agent')
    expect(item).toMatchObject({ kind: 'agent', title: 'Server fixes' })
  })

  test('provider child activity is inspectable and never enters the parent feed', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'tool_call', toolId: 'agent', toolName: 'Agent', index: 0, isSubagent: true })
    model.apply({ type: 'text_chunk', text: 'Reading the code.', parentToolUseId: 'agent' })
    model.apply({ type: 'tool_call', toolId: 'read', toolName: 'Read', index: 0, toolInput: '{"path":"a.ts"}', parentToolUseId: 'agent' })
    const agent = model.items.get(model.order[0])
    if (agent?.kind !== 'tool') throw new Error('Missing agent')
    expect(model.order).toHaveLength(1)
    expect(agent.children?.order.map((id) => agent.children?.items.get(id)?.kind)).toEqual(['assistant', 'tool'])
    expect(subagentPresentation(agent).providerItemId).toBe(agent.id)
    model.apply({ type: 'text_chunk', text: 'Done.', parentToolUseId: 'agent' })
    expect(model.order).toHaveLength(1)
  })

  test('a reload retains child history under the same provider card', () => {
    const model = TranscriptModel.fromHistory('s', { before: null, messages: [
      { role: 'tool', toolId: 'agent', toolName: 'Task', content: '', timestamp: 1 },
      { role: 'assistant', content: 'Child result', parentToolUseId: 'agent', timestamp: 2 },
    ] })
    const agent = model.items.get(model.order[0])
    expect(model.order).toHaveLength(1)
    if (agent?.kind !== 'tool') throw new Error('Missing agent')
    expect(agent.children?.items.get(agent.children.order[0])).toMatchObject({ kind: 'assistant', text: 'Child result' })
  })

  test('setup updates one card, and success closes every active stage', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'status_card', card: { id: 'setup', title: 'Preparing worktree', status: 'active', steps: [{ id: 'create', label: 'Create worktree', status: 'active' }] } })
    model.apply({ type: 'status_card', card: { id: 'setup', title: 'Starting agent', status: 'active', steps: [{ id: 'create', label: 'Create worktree', status: 'done' }, { id: 'start', label: 'Start agent', status: 'active' }], output: ['Created branch'] } })
    model.setStatus('running')
    expect(model.order).toEqual(['setup:setup'])
    expect(model.items.get('setup:setup')).toMatchObject({ card: { status: 'done', output: ['Created branch'], steps: [{ status: 'done' }, { status: 'done' }] } })
  })

  test('an MCP app survives replay and remains outside a completed work fold', () => {
    const activity: Activity = { id: 'a', kind: 'mcp_app', subject: { kind: 'session', id: 'earlier-session' }, at: 1, by: { kind: 'system' }, app: { integrationId: 'i', title: 'Chart', tool: 'chart', resourceUri: 'ui://chart', assetId: 'asset.json' } }
    const model = TranscriptModel.fromHistory('s', { before: null, messages: [{ role: 'activity', content: '', activity, timestamp: 1 }] })
    model.apply({ type: 'activity', activity })
    expect(model.order).toEqual(['activity:a'])
    // The app is read through the session its activity belongs to, not the one showing it.
    expect(model.items.get('activity:a')).toMatchObject({ sessionId: 'earlier-session' })
    expect(deriveThreadFeedPresentation({ entries: [{ id: 'activity:a', kind: 'mcp_app' }], turnActive: false, working: false, expandedTurnIds: new Set(), expandedWorkGroupIds: new Set() })).toEqual([{ type: 'mcp-app', id: 'activity:a' }])
  })
})
