import { describe, expect, test } from 'bun:test'
import type { ChangedFileStat, TurnSnapshot } from '@solus/contracts/git-types'
import type { SessionArtifact, SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { Message } from '@solus/contracts/types'
import {
  changeTotals,
  isInScope,
  overviewChanges,
  ownedArtifacts,
  scopedArtifacts,
  turnSnapshotIn,
  turnSpanAt,
} from '@solus/client-core/session-overview'
import type { TimelineTurn } from '@solus/client-core/turn-timeline'
import { changeKindShares, changesOfKind } from '@solus/workspace-ui/components/session/artifacts/lib/change-kinds'
import { changeTree, folderPaths } from '@solus/workspace-ui/components/session/artifacts/lib/change-tree'
import { overviewTiles } from '@solus/workspace-ui/components/session/artifacts/lib/overview-view'
import { scanSessionActivity, turnMessages } from '@solus/workspace-ui/components/session/artifacts/lib/session-activity'
import type { RailAgentRow } from '@solus/workspace-ui/components/project-panel/lib/rail-agents'

function pr(number: number, linkedAt: number, state?: 'open' | 'merged'): SessionArtifact {
  return {
    kind: 'pull-request',
    link: {
      sessionId: 's1',
      repository: 'github.com/acme/app',
      number,
      url: '',
      title: `PR ${number}`,
      source: 'agent',
      linkedAt,
      ...(state
        ? { snapshot: { number, url: '', title: '', state, draft: false, updatedAt: '', baseRepo: { host: 'github.com', owner: 'acme', repo: 'app' } } }
        : {}),
    },
  }
}
const work = (workId: string, linkedAt: number): SessionArtifact => ({ kind: 'work', workId, title: workId, workType: 'doc', linkedAt })
const file = (path: string, linkedAt: number): SessionArtifact => ({ kind: 'file', hostId: 'h1', path, title: path, linkedAt })
const image = (path: string, linkedAt: number): SessionArtifact => ({ kind: 'image', hostId: 'h1', path, title: path, linkedAt })
const automation = (id: string, linkedAt: number): SessionArtifact => ({ kind: 'automation', hostId: 'h1', automationId: id, title: id, linkedAt })

const turns: TimelineTurn[] = [
  { id: 'u1', startedAt: 100, endedAt: 150, prompt: 'first' },
  { id: 'u2', startedAt: 200, endedAt: 250, prompt: 'second' },
]

function snapshot(index: number, timestamp: number): TurnSnapshot {
  return { index, fromTreeSha: '', toTreeSha: '', sha: '', timestamp, partial: false, userMessagePreview: '', filesChanged: 1, additions: 1, deletions: 0 }
}

describe('the scope', () => {
  test('a turn holds what happened from its prompt until the next prompt; the last turn stays open', () => {
    // WHY: a link, an agent, or a checkpoint carries a time and no turn id.
    // The surface must put each one in exactly one turn.
    const first = turnSpanAt(turns, 0)
    const last = turnSpanAt(turns, 1)
    expect(isInScope(first, 100)).toBe(true)
    expect(isInScope(first, 199)).toBe(true)
    expect(isInScope(first, 200)).toBe(false)
    expect(isInScope(last, 200)).toBe(true)
    expect(isInScope(last, 9_999)).toBe(true)
    expect(isInScope(last, 199)).toBe(false)
  })

  test('with no turn selected, everything is in scope', () => {
    expect(isInScope(null, 0)).toBe(true)
  })
})

describe('linked artifacts', () => {
  const artifacts: SessionArtifacts = {
    own: [file('/r/a.ts', 110), pr(1, 120), work('plan', 210), image('/r/shot.png', 220), automation('nightly', 230)],
    children: [
      { sessionId: 'c1', title: 'Fix login', items: [pr(2, 215)] },
      { sessionId: 'c2', title: null, items: [file('/r/b.ts', 130)] },
    ],
  }
  const owned = ownedArtifacts(artifacts, 's1')

  test('each artifact keeps the session that linked it, so it opens in that session and a started one is named', () => {
    // WHY: a file or a pull request opens against its owner's project and host.
    expect(owned.map((entry) => [entry.ownerSessionId, entry.startedSessionTitle]).slice(-2)).toEqual([
      ['c1', 'Fix login'],
      ['c2', 'Untitled session'],
    ])
    expect(owned[0]).toMatchObject({ ownerSessionId: 's1', startedSessionTitle: null })
  })

  test('the whole session shows pull requests apart from the rest, each kind newest first', () => {
    const { pullRequests, items } = scopedArtifacts(owned, null, () => true)
    expect(pullRequests.map((entry) => entry.artifact.kind === 'pull-request' && entry.artifact.link.number)).toEqual([2, 1])
    expect(items.map((entry) => entry.artifact.kind)).toEqual(['work', 'automation', 'file', 'file', 'image'])
    // The two files, newest first: the started session's (130), then this session's (110).
    expect(items.filter((entry) => entry.artifact.kind === 'file').map((entry) => entry.ownerSessionId)).toEqual(['c2', 's1'])
  })

  test('a turn shows only what was linked in it, from this session and from the ones it started', () => {
    const second = scopedArtifacts(owned, turnSpanAt(turns, 1), () => true)
    expect(second.pullRequests.map((entry) => entry.ownerSessionId)).toEqual(['c1'])
    expect(second.items.map((entry) => entry.artifact.kind)).toEqual(['work', 'automation', 'image'])
    const first = scopedArtifacts(owned, turnSpanAt(turns, 0), () => true)
    expect(first.pullRequests).toHaveLength(1)
    expect(first.items.map((entry) => entry.artifact.kind)).toEqual(['file', 'file'])
  })

  test('the search narrows the rows inside the scope', () => {
    const found = scopedArtifacts(owned, null, (artifact) => artifact.kind === 'image')
    expect(found.pullRequests).toEqual([])
    expect(found.items).toHaveLength(1)
  })
})

describe('changed files', () => {
  const stats: ChangedFileStat[] = [
    { path: 'src/small.ts', additions: 2, deletions: 1, status: 'M' },
    { path: 'src/new.ts', additions: 40, deletions: 0, status: 'A' },
    { path: 'src/big.ts', additions: 60, deletions: 30, status: 'M' },
  ]

  test('with git counts, the largest change comes first', () => {
    // WHY: the card folds after a few rows; the rows it keeps must be the ones that matter.
    expect(overviewChanges(stats, ['ignored.ts']).map((change) => change.path)).toEqual(['src/big.ts', 'src/new.ts', 'src/small.ts'])
  })

  test('before git answers, the rows are the paths alone, and the totals are unknown, not zero', () => {
    // WHY: "+0 −0" would say the session changed nothing. Unknown must read as unknown.
    const changes = overviewChanges([], ['a.ts', 'b.ts'])
    expect(changes).toEqual([
      { path: 'a.ts', additions: null, deletions: null, status: null },
      { path: 'b.ts', additions: null, deletions: null, status: null },
    ])
    expect(changeTotals(changes)).toBeNull()
    expect(changeTotals(overviewChanges(stats, []))).toEqual({ additions: 102, deletions: 31 })
  })

  test('a turn reads the checkpoint written in it; a retried turn reads its last one', () => {
    const snapshots = [snapshot(0, 150), snapshot(1, 260), snapshot(2, 290)]
    expect(turnSnapshotIn(snapshots, turnSpanAt(turns, 0))?.index).toBe(0)
    expect(turnSnapshotIn(snapshots, turnSpanAt(turns, 1))?.index).toBe(2)
    expect(turnSnapshotIn([snapshot(0, 260)], turnSpanAt(turns, 0))).toBeNull()
  })
})

describe('reading the transcript', () => {
  const messages = [
    { id: 't0', role: 'tool', content: '', toolName: 'Read', timestamp: 90 },
    { id: 'u1', role: 'user', content: 'Fix   the\nlogin page', timestamp: 100 },
    { id: 't1', role: 'tool', content: '', toolName: 'Read', timestamp: 110, toolCompletedAt: 118 },
    { id: 'a1', role: 'assistant', content: 'Done', timestamp: 115 },
    { id: 'n1', role: 'user', content: '[Request interrupted by user]', timestamp: 120 },
    { id: 'sub', role: 'tool', content: '', toolName: 'Agent', timestamp: 125, subMessages: [] },
    { id: 'u2', role: 'user', content: 'Now the tests', timestamp: 200 },
    { id: 't2', role: 'tool', content: '', toolName: 'Edit', timestamp: 210 },
  ] as Message[]
  const activity = scanSessionActivity(messages)

  test('a prompt opens a turn, and a notice the agent SDK injected does not', () => {
    // WHY: the timeline must cut turns where the conversation cuts them.
    expect(activity.turns.map((turn) => [turn.id, turn.startedAt, turn.prompt])).toEqual([
      ['u1', 100, 'Fix the login page'],
      ['u2', 200, 'Now the tests'],
    ])
  })

  test('a turn ends at the last thing seen in it, a tool settling included', () => {
    expect(activity.turns.map((turn) => turn.endedAt)).toEqual([125, 210])
  })

  test('each tool call after the first prompt is one call at the time it started', () => {
    expect(activity.toolCallTimes).toEqual([110, 125, 210])
  })

  test('a sub-agent call is kept as an agent message, and one turn can be read alone', () => {
    expect(activity.agentMessages.map((message) => message.id)).toEqual(['sub'])
    expect(turnMessages(messages, activity, 0).map((message) => message.id)).toEqual(['u1', 't1', 'a1', 'n1', 'sub'])
    expect(turnMessages(messages, activity, 1).map((message) => message.id)).toEqual(['u2', 't2'])
  })
})

describe('the tiles', () => {
  const agent = (tone: RailAgentRow['tone']) => ({ tone }) as RailAgentRow

  test('each tile names its kind, counts it, and says in words how its rows stand', () => {
    // WHY: a number beside an icon does not say what it counts. A reader must
    // see "Agents 3, 1 running" without a tooltip and without opening the card.
    const linked = scopedArtifacts(
      ownedArtifacts({ own: [pr(1, 1, 'open'), pr(2, 2, 'merged'), pr(3, 3), work('w', 4), file('/a', 5), image('/b.png', 6)], children: [] }, 's1'),
      null,
      () => true,
    )
    const tiles = overviewTiles(
      overviewChanges([{ path: 'a.ts', additions: 5, deletions: 2, status: 'M' }], []),
      [agent('live'), agent('done'), agent('done')],
      linked.pullRequests,
      linked.items,
    )
    expect(tiles.map((tile) => [tile.label, tile.shortLabel, tile.count])).toEqual([
      ['Changes', 'Changes', 1],
      ['Agents', 'Agents', 3],
      ['Pull requests', 'PRs', 3],
      ['Works and files', 'Works', 3],
    ])
    expect(tiles[0]!.lines).toEqual({ additions: 5, deletions: 2 })
    expect(tiles[1]!.detail).toBe('1 running · 2 done')
    // A pull request PR sync has not seen yet has no state to count.
    expect(tiles[2]!.detail).toBe('1 open · 1 merged')
    expect(tiles[3]!.detail).toBe('1 work · 2 files')
  })

  test('a tile with nothing to say about its rows has no detail', () => {
    const tiles = overviewTiles([], [], [], [])
    expect(tiles.map((tile) => tile.detail)).toEqual([null, null, null, null])
  })
})

describe('the changes card', () => {
  const changes = overviewChanges(
    [
      { path: 'packages/ui/src/panel/lib/rows.ts', additions: 12, deletions: 0, status: 'A' },
      { path: 'packages/ui/src/panel/Card.svelte', additions: 30, deletions: 4, status: 'M' },
      { path: 'tests/unit/rows.test.ts', additions: 40, deletions: 2, status: 'A' },
    ],
    [],
  )

  test('is the directory tree the conversation card draws: a chain of single folders is one row', () => {
    // WHY: the reader knows this tree from the conversation. The same change
    // must not read as two different shapes in two places.
    const tree = changeTree(changes)
    expect(folderPaths(tree)).toEqual(['packages/ui/src/panel', 'packages/ui/src/panel/lib', 'tests/unit'])
    expect(tree.root.folders.map((folder) => [folder.label, folder.fileCount, folder.additions, folder.deletions])).toEqual([
      ['packages/ui/src/panel', 2, 42, 4],
      ['tests/unit', 1, 40, 2],
    ])
    expect(tree.root.folders[0]!.files.map((file) => file.name)).toEqual(['Card.svelte'])
  })

  test('before git answers, the tree is the paths alone', () => {
    const tree = changeTree(overviewChanges([], ['src/b.ts', 'src/a.ts']))
    expect(tree.total).toBe(2)
    expect(tree.root.folders[0]!.files.map((file) => file.name)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('the kinds of a change', () => {
  const changes = overviewChanges(
    [
      { path: 'src/panel/Card.svelte', additions: 60, deletions: 20, status: 'M' },
      { path: 'tests/unit/card.test.ts', additions: 15, deletions: 0, status: 'A' },
      { path: 'docs/plans/panel.md', additions: 4, deletions: 1, status: 'M' },
    ],
    [],
  )

  test('each kind the change touches has its file count and its part of the changed lines', () => {
    // WHY: the line over the tree says how much of a change is logic. A kind
    // the change does not touch has no chip, because a chip that shows
    // nothing is a dead end.
    expect(changeKindShares(changes).map((entry) => [entry.label, entry.fileCount, entry.share])).toEqual([
      ['Code', 1, 0.8],
      ['Tests', 1, 0.15],
      ['Docs', 1, 0.05],
    ])
  })

  test('until git has counted the lines, a kind takes its part of the files', () => {
    const shares = changeKindShares(overviewChanges([], ['a.ts', 'b.ts', 'c.ts', 'a.test.ts']))
    expect(shares.map((entry) => [entry.label, entry.share])).toEqual([
      ['Code', 0.75],
      ['Tests', 0.25],
    ])
  })

  test('a selected kind keeps only its files, and no kind keeps them all', () => {
    expect(changesOfKind(changes, 'tests').map((change) => change.path)).toEqual(['tests/unit/card.test.ts'])
    expect(changesOfKind(changes, null)).toHaveLength(3)
  })
})
