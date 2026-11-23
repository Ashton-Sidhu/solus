import { afterEach, describe, expect, test } from 'bun:test'
import type { SessionDigest, SessionTree, SessionTreeNode } from '@solus/contracts/session-digest'
import type { SessionExecution, SessionTurnOutcome } from '@solus/contracts/session-execution'
import type { SessionRecord } from '@solus/contracts/types'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { childRows, childRowsIn, descendantsOf, mergedFileChanges, treeOwnedArtifacts, treeTimeline, treeTotals, turnChanges } from '@solus/client-core/session-tree'
import { linkSections, scopedArtifacts } from '@solus/client-core/session-overview'
import { SessionTreeWatch, type SessionTreeView } from '@solus/client-core/session-tree-watch'
import { timelineBarText, timelineChartRows, timelineLayout } from '@solus/client-core/turn-timeline'
import { agentConversationLink } from '@solus/workspace-ui/components/conversation/agent-conversation/lib/agent-conversation'
import { treeAgentRows } from '@solus/workspace-ui/components/project-panel/lib/rail-agents'

/**
 * Desktop, web, and the phone draw the Threads surface from a session tree
 * alone (docs/plans/session-digests.md): no transcript and no checkout.
 */

const START = Date.parse('2026-11-21T10:00:07Z')

function record(sessionId: string, parentSessionId: string | null, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId, organizationId: 'local', publication: 'local', ownerKey: 'owner', provider: 'codex', projectPath: '/project',
    projectRemote: null, runnerHostId: null, title: `Session ${sessionId}`, customTitle: null, status: 'idle', model: null,
    reasoningEffort: null, parentSessionId, rootSessionId: null, createdAt: 1, lastActivityAt: 1, size: 0, cwd: '/project',
    slug: null, isWorktree: false, branch: null, projectRoot: null, delegation: null, place: null, startedBy: null, ...extra,
  }
}

function digest(sessionId: string, files: Array<[string, number, number]>, extra: Partial<SessionDigest> = {}): SessionDigest {
  return {
    sessionId,
    turns: [{ id: `${sessionId}-1`, startedAt: START, endedAt: START + 40_000, settled: true, prompt: 'Work', toolCalls: [[START, 3], [START + 30_000, 1]], changes: { filesChanged: files.length, additions: 1, deletions: 0 } }],
    changes: { files: files.map(([path, additions, deletions]) => ({ path, additions, deletions, status: 'M' as const })), filesChanged: files.length, additions: 0, deletions: 0 },
    subagents: [],
    lastReply: `${sessionId} is done.`,
    updatedAt: 1,
    ...extra,
  }
}

const node = (record: SessionRecord, digest: SessionDigest | null, artifacts: SessionTreeNode['artifacts'] = []): SessionTreeNode => ({ record, digest, artifacts })

const running: SessionExecution = { revision: 2, current: { runId: 'next', phase: 'running', startedAt: START }, lastTurn: null }
const settled = (outcome: SessionTurnOutcome): SessionExecution => ({
  revision: 1, current: null, lastTurn: { runId: 'first', startedAt: START, endedAt: START + 10_000, outcome },
})

const file = (path: string, linkedAt: number) => ({ kind: 'file' as const, hostId: 'host-1', path, title: path, linkedAt })

const tree: SessionTree = {
  nodes: [
    node(record('lead', null), digest('lead', [['shared.ts', 5, 1], ['lead.ts', 2, 0]]), [file('/plan.md', 3)]),
    node(record('child', 'lead', { customTitle: 'Build it' }), digest('child', [['shared.ts', 8, 2], ['child.ts', 4, 0]]), [file('/child.md', 5)]),
    node(record('remote', 'lead', { runnerHostId: 'host-b', status: 'running' }), null),
    node(record('grandchild', 'child'), digest('grandchild', [['deep.ts', 1, 1]])),
  ],
}

describe('session tree model', () => {
  test('the Agents panel takes direct delegates and provider calls from the same tree', () => {
    const withAgents = {
      nodes: [
        { ...node(record('lead', null, { provider: 'claude-code' }), digest('lead', [], {
          subagents: [
            { id: 'tool', title: 'Check the files', status: 'failed', startedAt: 2, endedAt: 3, detail: 'Read failed' },
          ],
        })), subagentExecutions: [{ toolId: 'tool', execution: settled('failed') }] },
        node(record('local-child', 'lead', { customTitle: 'Local delegate', execution: settled('interrupted') }), digest('local-child', [], {
          turns: [{ id: 'open', startedAt: 1, endedAt: 2, settled: false, prompt: 'Work', toolCalls: [], changes: null }],
        })),
        node(record('remote-child', 'lead', { runnerHostId: 'remote', execution: running, createdAt: 4 }), null),
        node(record('grandchild', 'local-child'), null),
      ],
    }
    const rows = treeAgentRows(withAgents, 'lead', 'local')
    expect(rows).toMatchObject([
      // A running delegate shows Working: the digest knows no live step. A stopped one shows no mark.
      { kind: 'session', id: 'remote-child', serverId: 'remote', standing: 'live', mark: { kind: 'dot', mark: 'working' }, endedAt: null },
      { kind: 'subagent', id: 'tool', provider: 'claude-code', standing: 'failed', mark: { kind: 'glyph', status: 'error' }, detail: 'Read failed' },
      { kind: 'session', id: 'local-child', serverId: 'local', title: 'Local delegate', standing: 'stopped', mark: null, status: 'Interrupted' },
    ])
    expect(treeAgentRows(withAgents, 'local-child', 'local').map((row) => row.id)).toEqual(['grandchild'])
  })
  test('a run outcome survives an empty digest and an old tree cannot hide a new run', () => {
    const child = record('child', 'lead', { createdAt: START })
    const rowsFor = (saved: SessionExecution | undefined, live?: SessionExecution) =>
      treeAgentRows({ nodes: [node({ ...child, execution: saved }, null)] }, 'lead', 'local', () => live)
    expect(rowsFor(undefined)[0]).toMatchObject({ status: 'Unknown' })
    expect(rowsFor(settled('completed'))[0]).toMatchObject({ status: 'Completed', standing: 'done', endedAt: START + 10_000 })
    expect(rowsFor(settled('completed'), running)[0]).toMatchObject({ status: 'Running', standing: 'live' })
    expect(rowsFor(running, settled('completed'))[0]).toMatchObject({ status: 'Running', standing: 'live' })
  })

  test('a conversation card and both panels show the same mark from the runner', () => {
    const child = record('child', 'lead', { runnerHostId: 'remote', execution: settled('completed') })
    const tree = { nodes: [node(child, null)] }
    const [row] = treeAgentRows(tree, 'lead', 'local',
      (serverId, sessionId) => serverId === 'remote' && sessionId === 'child' ? running : undefined,
      (serverId) => serverId === 'remote' ? 'read' : null,
    )
    const card = agentConversationLink({
      sessionId: 'child', provider: 'codex', title: 'Child', cwd: '/project', origin: 'created',
      exchanges: [{ messageId: 'first', index: 1, prompt: 'Work', dispatchedAt: START, status: 'done' }],
    }, running, 'read')
    expect(row).toMatchObject({ status: card.label, standing: card.standing, mark: { kind: 'dot', mark: 'reading' } })
    expect(row?.mark).toEqual(card.mark)
  })

  test('a timeline from the digest lays out as the conversation drew it', () => {
    // WHY: buckets start at the turn's start, as the bars do, so each call lands in its bar.
    const timeline = treeTimeline(tree.nodes[0]!.digest, START + 60_000)
    expect(timeline.turns).toEqual([{ id: 'lead-1', startedAt: START, endedAt: START + 40_000, prompt: 'Work' }])
    expect(timeline.toolCallTimes).toEqual([START, START, START, START + 30_000])
    const layout = timelineLayout(timeline.turns, timeline.toolCallTimes, 100)
    expect(layout.bars.slice(0, 3).map((bar) => bar.calls)).toEqual([3, 0, 1])
    // A turn that still runs ends at the present moment.
    const open = digest('lead', [], { turns: [{ ...tree.nodes[0]!.digest!.turns[0]!, settled: false }] })
    expect(treeTimeline(open, START + 90_000).turns[0]!.endedAt).toBe(START + 90_000)
    expect(turnChanges(tree.nodes[0]!.digest, 'lead-1')).toEqual({ filesChanged: 2, additions: 1, deletions: 0 })
  })

  test('the total counts each file once, with the larger of two sessions’ changes to it', () => {
    // WHY: a child in its parent's worktree shows a shared file in both
    // sections; the total must not count the file, or its lines, twice.
    expect(treeTotals(tree)).toEqual({ filesChanged: 4, additions: 8 + 2 + 4 + 1, deletions: 2 + 1, complete: true })
    const cut = { nodes: [node(record('lead', null), digest('lead', [['a.ts', 1, 0]], { changes: { files: [{ path: 'a.ts', additions: 1, deletions: 0, status: 'M' }], filesChanged: 900, additions: 1, deletions: 0 } }))] }
    expect(treeTotals(cut)?.complete).toBe(false)
    expect(treeTotals({ nodes: [node(record('lead', null), null)] })).toBeNull()
  })

  test('each session below shows a row from its own record and digest', () => {
    const rows = childRows(tree, 'lead', START + 60_000)
    expect(rows.map((row) => [row.sessionId, row.title, row.isRemote, row.isRunning, row.descendantCount])).toEqual([
      ['child', 'Build it', false, false, 1],
      ['remote', 'Session remote', true, true, 0],
    ])
    expect(rows[0]).toMatchObject({ workedMs: 40_000, lastReply: 'child is done.', changes: { filesChanged: 2 }, artifactCount: 1 })
    expect(rows[1]).toMatchObject({ workedMs: 0, lastReply: null, changes: null })
    expect(descendantsOf(tree, 'lead').map((each) => each.record.sessionId)).toEqual(['child', 'remote', 'grandchild'])
  })

  test("every node's artifacts carry the session that linked them", () => {
    expect(treeOwnedArtifacts(tree).map((owned) => [owned.ownerSessionId, owned.startedSessionTitle])).toEqual([
      ['lead', null],
      ['child', 'Build it'],
    ])
  })
})

describe('agent filter model', () => {
  test('All shows each file once, as the larger of two sessions’ changes to it', () => {
    // WHY: a child in its parent's worktree shows a shared file in both
    // sessions; the All view must not list it, or count its lines, twice.
    const merged = mergedFileChanges([
      [{ path: 'shared.ts', additions: 5, deletions: 1, status: 'M' }, { path: 'own.ts', additions: 2, deletions: 0, status: 'A' }],
      [{ path: 'shared.ts', additions: 8, deletions: 0, status: 'M' }],
    ])
    expect(merged).toEqual([
      { path: 'shared.ts', additions: 8, deletions: 1, status: 'M' },
      { path: 'own.ts', additions: 2, deletions: 0, status: 'A' },
    ])
  })

  test("a turn's card offers the sessions that worked in that turn", () => {
    const late = node(record('late', 'lead', { createdAt: START + 500_000 }), digest('late', [], { turns: [] }))
    const withTurns: SessionTree = { nodes: [...tree.nodes, late] }
    // `child` had a turn start at START; `remote` and `late` started outside the span.
    expect(childRowsIn(withTurns, 'lead', START, { from: START - 1, until: START + 100_000 }).map((row) => row.sessionId)).toEqual(['child'])
    expect(childRowsIn(withTurns, 'lead', START, { from: START + 400_000, until: null }).map((row) => row.sessionId)).toEqual(['late'])
  })

  test('under one session every link is its own; under All a link names the session that made it', () => {
    expect(treeOwnedArtifacts(tree, 'child').map((owned) => [owned.ownerSessionId, owned.startedSessionTitle])).toEqual([['child', null]])
    expect(treeOwnedArtifacts(tree, 'lead').map((owned) => owned.ownerSessionId)).toEqual(['lead'])
  })

  test('each kind of link has its own card, in a fixed order, and a kind with none has no card', () => {
    const owned = [
      { artifact: file('/notes.md', 4), ownerSessionId: 'lead', startedSessionTitle: null },
      { artifact: { kind: 'work' as const, workId: 'w1', title: 'Plan', workType: 'doc' as const, linkedAt: 2 }, ownerSessionId: 'lead', startedSessionTitle: null },
      { artifact: { kind: 'image' as const, hostId: 'host-1', path: '/a.png', title: 'a.png', linkedAt: 3 }, ownerSessionId: 'child', startedSessionTitle: 'Build it' },
      { artifact: file('/older.md', 1), ownerSessionId: 'lead', startedSessionTitle: null },
    ]
    const sections = linkSections(scopedArtifacts(owned, null, () => true))
    expect(sections.map((section) => [section.title, section.items.length])).toEqual([['Works', 1], ['Files', 2], ['Images', 1]])
    // Newest first inside a card.
    expect(sections[1]!.items.map((item) => item.artifact.kind === 'file' && item.artifact.path)).toEqual(['/notes.md', '/older.md'])
  })

  test("under All, the agents' calls stack on the session's own bars, and the readout names them", () => {
    const turns = [{ id: 't', startedAt: START, endedAt: START + 60_000, prompt: 'Go' }]
    const layout = timelineLayout(turns, [START, START + 1_000], 100, [START + 2_000, START + 20_000, START - 60_000])
    expect(layout.bars.slice(0, 2).map((bar) => [bar.calls, bar.agentCalls])).toEqual([[2, 1], [0, 1]])
    expect(timelineBarText(layout.bars[0]!)).toBe('2 tool calls, 1 by agents')
    const rows = timelineChartRows(layout, 0, 0.05)
    const [, ownTop] = rows[0]!.own!
    const [agentsBottom, agentsTop] = rows[0]!.agents!
    // The agents' part sits on the session's own, and is the smaller of the two.
    expect(agentsBottom).toBe(ownTop)
    expect(ownTop).toBeGreaterThan(agentsTop - agentsBottom)
    // A span with no calls draws nothing; an agent call before the session's turn has no bar.
    expect(rows[3]).toMatchObject({ own: null, agents: null })
    expect(layout.bars.reduce((total, bar) => total + bar.agentCalls, 0)).toBe(2)
  })
})

describe('SessionTreeWatch', () => {
  let running: SessionTreeWatch | null = null
  afterEach(() => running?.stop())

  function harness() {
    const events = new HostEventSubscriber()
    const views: SessionTreeView[] = []
    const reads: string[] = []
    let answer: SessionTree | Error = tree
    let release: (() => void) | null = null
    const api = {
      sessionTree: async (sessionId: string) => {
        reads.push(sessionId)
        await new Promise<void>((resolve) => { release = resolve })
        if (answer instanceof Error) throw answer
        return answer
      },
    }
    const watch = new SessionTreeWatch({ api, events, sessionId: 'lead', onChange: (view) => views.push(view) })
    running = watch
    const settle = async () => {
      while (release) {
        const next = release
        release = null
        next()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    return { watch, events, views, reads, settle, answer: (next: SessionTree | Error) => { answer = next } }
  }

  test('it reads once, and again only for a change to its session or a work it lists', async () => {
    const h = harness()
    h.watch.start()
    await h.settle()
    expect(h.views.at(-1)).toEqual({ tree, loading: false, stale: false })
    h.events.receive({ type: 'session.digestChanged', payload: { sessionId: 'other' }, occurredAt: 0 })
    h.events.receive({ type: 'works.changed', payload: { workId: 'not-listed' }, occurredAt: 0 })
    expect(h.reads).toEqual(['lead'])
    h.events.receive({ type: 'session.artifactsChanged', payload: { sessionId: 'lead' }, occurredAt: 0 })
    await h.settle()
    expect(h.reads).toEqual(['lead', 'lead'])
  })

  test('changes heard during a read make one more read, never an overlapping one', async () => {
    // WHY: the last answer must never be older than the last change.
    const h = harness()
    h.watch.start()
    h.events.receive({ type: 'session.digestChanged', payload: { sessionId: 'lead' }, occurredAt: 0 })
    h.events.receive({ type: 'session.digestChanged', payload: { sessionId: 'lead' }, occurredAt: 0 })
    await h.settle()
    expect(h.reads).toEqual(['lead', 'lead'])
  })

  test('a failed read keeps the last tree and says it is stale', async () => {
    const h = harness()
    h.watch.start()
    await h.settle()
    h.answer(new Error('Host is offline'))
    void h.watch.refresh()
    await h.settle()
    expect(h.views.at(-1)).toEqual({ tree, loading: false, stale: true })
  })
})
