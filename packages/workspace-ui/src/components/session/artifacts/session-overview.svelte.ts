import { untrack } from 'svelte'
import type { TurnSnapshot } from '@solus/contracts/git-types'
import type { SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { Session } from '@solus/contracts/types'
import type { TurnSpan } from '@solus/client-core/session-artifact-chips'
import {
  isInScope,
  overviewChanges,
  ownedArtifacts,
  scopedArtifacts,
  turnSnapshotIn,
  turnSpanAt,
  type OverviewChange,
  type OwnedArtifact,
  type ScopedArtifacts,
} from '@solus/client-core/session-overview'
import type { TimelineTurn } from '@solus/client-core/turn-timeline'
import { sessionArtifactsStore } from '../../../contexts/sessions/session-artifacts.store.svelte'
import { projectRoot } from '../../../contexts/workspace/run-location'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { extractChangedFilePaths } from '../../../lib/changedFiles'
import { agentConversationMeta } from '../../conversation/agent-conversation/agent-conversation-meta.store.svelte'
import { hostLabelFor } from '../../conversation/agent-conversation/lib/agent-conversation'
import { diffSummaryStore, type DiffSummaryScope } from '../../conversation/diff-summary.store.svelte'
import { runIsLive } from '../../conversation/lib/turns'
import { railAgentList, type RailAgentRow } from '../../project-panel/lib/rail-agents'
import { artifactMatchesQuery } from './lib/artifact-list'
import { agentLinkCounts, overviewTiles, textMatchesQuery, type AgentLinkCounts, type OverviewKind, type OverviewTile } from './lib/overview-view'
import { scanSessionActivity, turnMessages, type SessionActivity } from './lib/session-activity'

type OverviewWorkspace = Pick<WorkspaceContext, 'sessions' | 'lifecycle' | 'tabIdForSession'>

const NO_ACTIVITY: SessionActivity = { turns: [], toolCallTimes: [], promptIndexes: [], agentMessages: [] }

/**
 * What the Artifacts surface shows for one session, and the scope it shows it
 * in (docs/plans/session-artifacts.md). The timeline and the agents come from
 * the session's transcript, so they need the conversation open in this
 * workspace. The linked artifacts come from the host's read, so they show for
 * any session. The changed files come from git, through the session's turn
 * checkpoints.
 *
 * The scope is a turn or the whole session; the kind narrows the cards to one
 * tile; the query narrows the rows. The tiles count the scope, not the query:
 * a search looks for a row, it does not change how much the turn did.
 */
export class SessionOverview {
  /** The turn the surface is scoped to, by its prompt's id, so it holds when earlier history loads. */
  scopeTurnId = $state<string | null>(null)
  /** The one kind whose card shows. Null shows every kind. */
  kind = $state<OverviewKind | null>(null)
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

  readonly toolCallTimes: readonly number[] = $derived.by(() => this.activity.toolCallTimes)

  /** The turns, the last one still open while the session works. */
  readonly turns: TimelineTurn[] = $derived.by(() => {
    const turns = this.activity.turns
    if (!this.live || turns.length === 0) return turns
    const last = turns[turns.length - 1]
    return [...turns.slice(0, -1), { ...last, endedAt: Math.max(last.endedAt, this.now) }]
  })

  readonly scopeIndex: number | null = $derived.by(() => {
    if (this.scopeTurnId === null) return null
    const index = this.activity.turns.findIndex((turn) => turn.id === this.scopeTurnId)
    return index === -1 ? null : index
  })
  readonly scope: TurnSpan | null = $derived.by(() =>
    this.scopeIndex === null ? null : turnSpanAt(this.activity.turns, this.scopeIndex),
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
  private readonly scopedAgents: RailAgentRow[] = $derived.by(() =>
    this.agentRows.filter((row) => isInScope(this.scope, row.startedAt)),
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

  /** What a started session linked. Null for a sub-agent, and until the artifacts are read. */
  linksOf(row: RailAgentRow): AgentLinkCounts | null {
    if (row.kind !== 'session') return null
    const items = this.artifacts?.children.find((group) => group.sessionId === row.id)?.items
    return items ? agentLinkCounts(items) : null
  }

  // ─── Changes ───

  private readonly snapshots: readonly TurnSnapshot[] = $derived.by(() => this.workspace.lifecycle.turnSnapshots[this.sessionId()] ?? [])
  private readonly scopeSnapshot: TurnSnapshot | null = $derived.by(() => (this.scope ? turnSnapshotIn(this.snapshots, this.scope) : null))

  /** The diff git is asked for: the session's, or the selected turn's checkpoint. Null for a turn that has none. */
  readonly changeScope: DiffSummaryScope | null = $derived.by(() => {
    if (!this.scope) return { kind: 'session' }
    return this.scopeSnapshot ? { kind: 'turn', index: this.scopeSnapshot.index } : null
  })

  /** The paths the transcript names, for a scope git has not counted: the session's, or a turn with no checkpoint yet. */
  readonly changePaths: string[] = $derived.by(() => {
    const session = this.session
    if (!session) return []
    if (this.scopeIndex === null) return session.sessionChangedFiles
    if (this.scopeSnapshot) return []
    return extractChangedFilePaths(turnMessages(session.messages, this.activity, this.scopeIndex), {
      projectPath: projectRoot(session.run) ?? undefined,
    })
  })

  private readonly scopedChanges: OverviewChange[] = $derived.by(() =>
    overviewChanges(this.changeScope ? diffSummaryStore.statsFor(this.sessionId(), this.changeScope) : [], this.changePaths),
  )
  readonly changes: OverviewChange[] = $derived.by(() => this.scopedChanges.filter((change) => textMatchesQuery(change.path, this.query)))

  // ─── Linked artifacts ───

  private readonly owned: OwnedArtifact[] = $derived.by(() => (this.artifacts ? ownedArtifacts(this.artifacts, this.sessionId()) : []))
  private readonly scopedLinked: ScopedArtifacts = $derived.by(() => scopedArtifacts(this.owned, this.scope, () => true))
  readonly linked: ScopedArtifacts = $derived.by(() =>
    scopedArtifacts(this.owned, this.scope, (artifact) => artifactMatchesQuery(artifact, this.query)),
  )

  // ─── The whole ───

  readonly tiles: OverviewTile[] = $derived.by(() =>
    overviewTiles(this.scopedChanges, this.scopedAgents, this.scopedLinked.pullRequests, this.scopedLinked.items),
  )

  /** Whether the session has anything at all to show: before any scope, kind, or search. */
  readonly hasAnything: boolean = $derived.by(
    () =>
      this.activity.turns.length > 0 ||
      this.owned.length > 0 ||
      this.agentRows.length > 0 ||
      (this.session?.sessionChangedFiles.length ?? 0) > 0,
  )

  /** Whether the kind's card shows: the kind is not narrowed away, and it has rows. */
  shows(kind: OverviewKind, rowCount: number): boolean {
    return rowCount > 0 && (this.kind === null || this.kind === kind)
  }

  /** Back to everything: the whole session, every kind, no search. */
  clear(): void {
    this.scopeTurnId = null
    this.kind = null
    this.query = ''
  }
}
