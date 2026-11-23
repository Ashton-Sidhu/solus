import { untrack } from 'svelte'
import type { ChangedFileStat, TurnSnapshot } from '@solus/contracts/git-types'
import type { SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { SessionTree, SessionTreeNode } from '@solus/contracts/session-digest'
import type { Session } from '@solus/contracts/types'
import type { TurnSpan } from '@solus/client-core/session-artifact-chips'
import {
  isInScope,
  linkSections,
  overviewChanges,
  ownedArtifacts,
  scopedArtifacts,
  turnSnapshotIn,
  turnSpanAt,
  type LinkSection,
  type OverviewChange,
  type OwnedArtifact,
  type ScopedArtifacts,
} from '@solus/client-core/session-overview'
import { childRows, mergedFileChanges, scopedNodes, treeOwnedArtifacts, treeTimeline, type AgentScope, type TreeSessionRow } from '@solus/client-core/session-tree'
import type { TimelineTurn } from '@solus/client-core/turn-timeline'
import { recentArtifacts, type RecentArtifact } from '@solus/client-core/recent-artifacts'
import { artifactOpensStore } from '../../../contexts/sessions/artifact-opens.store.svelte'
import { sessionArtifactsStore } from '../../../contexts/sessions/session-artifacts.store.svelte'
import { sessionTreeStore } from '../../../contexts/sessions/session-tree.store.svelte'
import { projectRoot } from '../../../contexts/workspace/run-location'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { extractChangedFilePaths } from '../../../lib/changedFiles'
import { agentConversationMeta } from '../../conversation/agent-conversation/agent-conversation-meta.store.svelte'
import { hostLabelFor } from '../../conversation/agent-conversation/lib/agent-conversation'
import { diffSummaryStore, type DiffSummaryScope } from '../../conversation/diff-summary.store.svelte'
import { runIsLive } from '../../conversation/lib/turns'
import { railAgentList, type RailAgentRow } from '../../project-panel/lib/rail-agents'
import { artifactMatchesQuery } from './lib/artifact-list'
import { textMatchesQuery } from './lib/overview-view'
import { scanSessionActivity, turnMessages, type SessionActivity } from './lib/session-activity'

type OverviewWorkspace = Pick<WorkspaceContext, 'sessions' | 'lifecycle' | 'tabIdForSession'>

const NO_ACTIVITY: SessionActivity = { turns: [], toolCallTimes: [], promptIndexes: [], agentMessages: [] }

/**
 * What the Threads surface shows for one session, and the scope it shows it
 * in (docs/plans/session-artifacts.md, docs/plans/session-digests.md).
 *
 * Two scopes narrow the cards: the agent filter (the whole tree of the session
 * and the sessions it started, the session alone, or one session it started)
 * and a turn of the timeline; the query narrows the rows. The session's own
 * timeline, agents, and changes come from its transcript and git while its
 * conversation is open in this workspace, else from its digest. A started
 * session's come from its digest, and every link from the session tree.
 */
export class SessionOverview {
  /** The turn the surface is scoped to, by its prompt's id, so it holds when earlier history loads. */
  scopeTurnId = $state<string | null>(null)
  /** The agent filter, as picked. A session that left the tree reads as the whole tree (`agentScope`). */
  pickedAgentScope = $state<AgentScope>('all')
  query = $state('')
  /** The present moment, which a live turn ends at and a running agent counts to. The surface ticks it. */
  now = $state(Date.now())

  constructor(
    private readonly workspace: OverviewWorkspace,
    private readonly sessionId: () => string,
    private readonly serverId: () => string,
  ) {}

  /** The session, when its conversation is open in this workspace. */
  readonly session: Session | undefined = $derived.by(() => this.workspace.sessions.byId[this.sessionId()])
  readonly live: boolean = $derived.by(() => runIsLive(this.session?.status))
  readonly artifacts: SessionArtifacts | null = $derived.by(() => sessionArtifactsStore.artifactsFor(this.sessionId()))
  readonly tree: SessionTree | null = $derived.by(() => sessionTreeStore.treeFor(this.sessionId()))
  private readonly ownNode: SessionTreeNode | null = $derived.by(() => this.tree?.nodes[0] ?? null)

  /**
   * One read of the transcript for each appended message. The scan itself is
   * untracked: it would otherwise subscribe to every message it reads, and a
   * tool call that settles would then cost a walk of the whole transcript.
   */
  private readonly activity: SessionActivity = $derived.by(() => {
    const messages = this.session?.messages
    if (!messages) return NO_ACTIVITY
    void messages.length
    return untrack(() => scanSessionActivity(messages))
  })

  // ─── The agent filter ───

  /** The sessions this one started, as the filter offers them: oldest started first. */
  readonly agentChoices: TreeSessionRow[] = $derived.by(() => (this.tree ? childRows(this.tree, this.sessionId(), this.now) : []))
  readonly agentScope: AgentScope = $derived.by(() => {
    const picked = this.pickedAgentScope
    if (picked === 'all' || picked === this.sessionId()) return picked
    return this.agentChoices.some((choice) => choice.sessionId === picked) ? picked : 'all'
  })
  /** The filter's session: this one under the whole tree and under itself, else the started session picked. */
  private readonly focusId: string = $derived.by(() => (this.agentScope === 'all' ? this.sessionId() : this.agentScope))
  private readonly isOwnFocus: boolean = $derived.by(() => this.focusId === this.sessionId())
  private readonly focusNode: SessionTreeNode | null = $derived.by(() =>
    this.tree?.nodes.find((node) => node.record.sessionId === this.focusId) ?? null,
  )

  /** When this host last copied the filter's session from the host that runs it; null for a session this host runs. */
  readonly focusCopiedAt: number | null = $derived.by(() => {
    const node = this.focusNode
    if (!node?.record.runnerHostId) return null
    return node.digest?.updatedAt ?? node.record.lastActivityAt
  })

  /** Pick the filter. A turn of one session's timeline is no turn of another's, so the turn scope clears. */
  selectAgent(scope: AgentScope): void {
    if (scope === this.agentScope) return
    this.pickedAgentScope = scope
    this.scopeTurnId = null
  }

  // ─── The timeline ───

  /** The focus's turns and tool calls: from the transcript while the session's conversation is open, else its digest. */
  private readonly timeline: { turns: TimelineTurn[]; toolCallTimes: readonly number[]; live: boolean } = $derived.by(() => {
    if (this.isOwnFocus && this.session) {
      return { turns: this.activity.turns, toolCallTimes: this.activity.toolCallTimes, live: this.live }
    }
    const { turns, toolCallTimes } = treeTimeline(this.focusNode?.digest ?? null, this.now)
    return { turns, toolCallTimes, live: this.focusNode?.digest?.turns.at(-1)?.settled === false }
  })

  readonly toolCallTimes: readonly number[] = $derived.by(() => this.timeline.toolCallTimes)
  /** Under the whole tree: the tool calls of every session below this one, drawn on this session's bars. */
  readonly agentCallTimes: readonly number[] = $derived.by(() => {
    if (this.agentScope !== 'all' || !this.tree) return []
    return this.tree.nodes.slice(1).flatMap((node) => treeTimeline(node.digest, this.now).toolCallTimes)
  })

  /** The timeline's turns, the last one still open while its session works. */
  readonly turns: TimelineTurn[] = $derived.by(() => {
    const { turns, live } = this.timeline
    if (!live || turns.length === 0) return turns
    const last = turns[turns.length - 1]
    return [...turns.slice(0, -1), { ...last, endedAt: Math.max(last.endedAt, this.now) }]
  })
  readonly timelineLive: boolean = $derived.by(() => this.timeline.live)

  readonly scopeIndex: number | null = $derived.by(() => {
    if (this.scopeTurnId === null) return null
    const index = this.timeline.turns.findIndex((turn) => turn.id === this.scopeTurnId)
    return index === -1 ? null : index
  })
  readonly scope: TurnSpan | null = $derived.by(() =>
    this.scopeIndex === null ? null : turnSpanAt(this.timeline.turns, this.scopeIndex),
  )

  // ─── Agents ───

  private readonly agentRows: RailAgentRow[] = $derived.by(() => {
    const session = this.session
    if (!session) return []
    const list = railAgentList(this.activity.agentMessages, this.now, {
      fallback: {
        model: (session.sessionModel || session.run.modelConfig.modelId || '').trim(),
        effort: (session.run.modelConfig.reasoningEffort || '').trim(),
      },
      metaFor: (sessionId) => agentConversationMeta.metaFor(sessionId),
      hostLabel: hostLabelFor(this.serverId()),
    })
    return [...list.active, ...list.previous]
  })
  /** The Agents card lists this session's agents; under a started session's filter it has none to list here. */
  private readonly scopedAgents: RailAgentRow[] = $derived.by(() =>
    this.isOwnFocus ? this.agentRows.filter((row) => isInScope(this.scope, row.startedAt)) : [],
  )
  readonly agents: RailAgentRow[] = $derived.by(() => this.scopedAgents.filter((row) => textMatchesQuery(row.title, this.query)))
  readonly hasLiveAgent: boolean = $derived.by(() => this.agentRows.some((row) => row.tone === 'live'))

  /** The started sessions whose index record the agent rows read, as `sessionId host` lines. */
  readonly startedSessionKeys: string = $derived.by(() =>
    [
      ...new Set(
        this.activity.agentMessages.flatMap((message) => {
          const ref = message.agentConversationRef
          return ref && !ref.starting ? [`${ref.sessionId} ${ref.serverId ?? ''}`] : []
        }),
      ),
    ].join('\n'),
  )

  // ─── Changes ───

  private readonly snapshots: readonly TurnSnapshot[] = $derived.by(() => this.workspace.lifecycle.turnSnapshots[this.sessionId()] ?? [])
  private readonly scopeSnapshot: TurnSnapshot | null = $derived.by(() =>
    this.scope && this.isOwnFocus && this.session ? turnSnapshotIn(this.snapshots, this.scope) : null,
  )

  /** The diff git is asked for, for this session's own changes: the session's, or the selected turn's checkpoint. Null when git is not asked. */
  readonly changeScope: DiffSummaryScope | null = $derived.by(() => {
    if (!this.isOwnFocus || !this.session) return null
    if (!this.scope) return { kind: 'session' }
    return this.scopeSnapshot ? { kind: 'turn', index: this.scopeSnapshot.index } : null
  })

  /** The paths the transcript names, for a scope git has not counted: the session's, or a turn with no checkpoint yet. */
  readonly changePaths: string[] = $derived.by(() => {
    const session = this.session
    if (!session || !this.isOwnFocus) return []
    if (this.scopeIndex === null) return session.sessionChangedFiles
    if (this.scopeSnapshot) return []
    return extractChangedFilePaths(turnMessages(session.messages, this.activity, this.scopeIndex), {
      projectPath: projectRoot(session.run) ?? undefined,
    })
  })

  /** This session's own files: from git while its conversation is open, else from its digest. A turn of a digest has totals, not files. */
  private readonly ownStats: readonly ChangedFileStat[] = $derived.by(() => {
    if (this.session) return this.changeScope ? diffSummaryStore.statsFor(this.sessionId(), this.changeScope) : []
    return this.scope ? [] : this.ownNode?.digest?.changes?.files ?? []
  })

  /** The session each changed path belongs to: this one first, then the started session that changed it first. */
  readonly changeOwners: ReadonlyMap<string, string> = $derived.by(() => {
    const owners = new Map<string, string>()
    if (this.isOwnFocus) for (const stat of this.ownStats) owners.set(stat.path, this.sessionId())
    if (this.agentScope === 'all' || !this.isOwnFocus) {
      for (const node of this.otherNodes) {
        for (const file of node.digest?.changes?.files ?? []) if (!owners.has(file.path)) owners.set(file.path, node.record.sessionId)
      }
    }
    return owners
  })

  /** The started sessions whose changes the scope holds, each whole: their digests have no files for one turn of this timeline. */
  private readonly otherNodes: SessionTreeNode[] = $derived.by(() => {
    if (!this.tree) return []
    if (this.agentScope === 'all') return this.scope ? [] : this.tree.nodes.slice(1)
    if (this.isOwnFocus) return []
    return this.scope ? [] : scopedNodes(this.tree, this.focusId)
  })

  private readonly scopedChanges: OverviewChange[] = $derived.by(() => {
    const own = this.isOwnFocus ? this.ownStats : []
    const others = this.otherNodes.map((node) => node.digest?.changes?.files ?? [])
    const paths = this.isOwnFocus ? this.changePaths : []
    return overviewChanges(others.length ? mergedFileChanges([own, ...others]) : own, paths)
  })
  readonly changes: OverviewChange[] = $derived.by(() => this.scopedChanges.filter((change) => textMatchesQuery(change.path, this.query)))

  // ─── Linked artifacts ───

  /** Every link of the tree, each with its session: what the recent row shows, whatever the scope. */
  private readonly allOwned: OwnedArtifact[] = $derived.by(() => {
    if (this.tree) return treeOwnedArtifacts(this.tree)
    return this.artifacts ? ownedArtifacts(this.artifacts, this.sessionId()) : []
  })
  private readonly owned: OwnedArtifact[] = $derived.by(() =>
    this.tree && this.agentScope !== 'all' ? treeOwnedArtifacts(this.tree, this.focusId) : this.allOwned,
  )
  readonly linked: ScopedArtifacts = $derived.by(() =>
    scopedArtifacts(this.owned, this.scope, (artifact) => artifactMatchesQuery(artifact, this.query)),
  )
  /** One card for each kind of link the scope holds. */
  readonly linkCards: LinkSection[] = $derived.by(() => linkSections(this.linked))

  /** The works, apps, files, and images to show first: pinned, then the latest opened, changed, or linked. */
  readonly recent: RecentArtifact[] = $derived.by(() => recentArtifacts(this.allOwned, (artifact) => artifactOpensStore.openedAt(artifact)))

  // ─── The whole ───

  /** Whether the session has anything at all to show: before any scope or search. */
  readonly hasAnything: boolean = $derived.by(
    () =>
      this.activity.turns.length > 0 ||
      this.allOwned.length > 0 ||
      this.agentRows.length > 0 ||
      this.agentChoices.length > 0 ||
      (this.tree?.relations?.length ?? 0) > 0 ||
      (this.ownNode?.digest?.turns.length ?? 0) > 0 ||
      (this.session?.sessionChangedFiles.length ?? 0) > 0,
  )

  /** Back to everything: the whole tree and the whole session, no search. */
  clear(): void {
    this.scopeTurnId = null
    this.pickedAgentScope = 'all'
    this.query = ''
  }
}
