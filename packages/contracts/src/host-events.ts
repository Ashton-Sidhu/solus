import type { DeviceState } from './device-types'
import type { CheckoutChange } from './checkout'
import type { AtlassianOAuthCompleted } from './atlassian'
import type { HostConfigSnapshot } from './host-config'
import type { ConnectionConnectNeeded } from './connections'
import type { AttentionEntry } from './attention-types'
import type { ReviewGuideStatusEvent, ReviewProgressEvent, PrGuideStatusEvent, ReviewLensChangedEvent } from './review'
import type { PrSyncChange } from './providers'
import type {
  AgentUsageLimits,
  AnnotationsChanged,
  AutomationsChangedEvent,
  DeviceCodePrompt,
  EnrichedError,
  WireNormalizedEvent,
  SessionIndexUpdatedEvent,
  SessionStatus,
  SessionTitleChangedEvent,
  SetupLogEvent,
  SetupStatusEvent,
  ModelProfilesStatus,
  VoiceModelStatus,
} from './types'
import type { GitActionProgressEvent } from './git-types'
import type { BrowserPage, BrowserProfileSet } from './browser-types'
import type { CodeIntelStatus } from './code-intel'
import type { InsightPullState } from './observability-types'
import type { HostUpdateStatus } from './host-update-types'
import type { ShareChangedEvent } from './sharing'
import type { SeatChangedEvent } from './seats'
import type { AgentAuthFinishedEvent } from './agent-auth'
import type { IntegrationChangedEvent } from './integration-types'
import type { HostPresenceSnapshot, SessionPresenceSnapshot, WorkPresenceSnapshot } from './presence'
import type { HostOrganizationsStatus } from './organization-scope'
import type { UplinkStatus } from './uplink'
import type { WorkReviewsChanged } from './work-review'
import type { NotificationsChanged } from './notification-hub'
import type { WorkLiveAwarenessEvent, WorkLiveStateEvent, WorkLiveUpdateEvent } from './work-live'
import { z } from 'zod'

/**
 * Canonical contract for facts published by one Solus host to its clients.
 * Commands and queries remain RPC methods; native shell signals stay local.
 */
export interface HostEventMap {
  'git.checkoutChanged': CheckoutChange
  'session.eventReceived': { sessionId: string; event: WireNormalizedEvent }
  'session.errorReceived': { sessionId: string; error: EnrichedError }
  'session.indexChanged': SessionIndexUpdatedEvent
  'session.titleChanged': SessionTitleChangedEvent
  /** This session was read, or returned to unread, on some client. Every other
   *  mounted surface adopts the boundary so reading on one device clears the
   *  indicator on the rest. `viewedAt` is null when the session is unread. */
  'session.readStateChanged': { sessionId: string; viewedAt: number | null }
  /** The pull requests linked to this session changed, or PR sync saw one of
   *  them change. Clients read `sessionPullRequestsList` for the session. */
  'session.pullRequestsChanged': { sessionId: string }
  /** The session was settled, made active, snoozed or woken. Clients read
   *  `sessionShelfList` for the session. */
  'session.stateChanged': { sessionId: string }
  /** `agentSessionId` is a correlation attribute, not a second address: the
   *  picker and agent-conversation cards hold only a provider thread id. */
  'session.transcriptChanged': { sessionId: string }
  'session.statusChanged': { sessionId: string; agentSessionId: string | null; status: SessionStatus; at: number }
  'setup.statusChanged': SetupStatusEvent
  'setup.logAppended': SetupLogEvent
  'voice.modelStatusChanged': VoiceModelStatus
  'automation.changed': AutomationsChangedEvent
  'provider.deviceCodeReceived': DeviceCodePrompt
  'git.actionProgressed': GitActionProgressEvent
  'review.progressChanged': ReviewProgressEvent
  'review.guideStatusChanged': ReviewGuideStatusEvent
  'review.lensChanged': ReviewLensChangedEvent
  /** A task changed. `taskId` names it; no id means many tasks changed at
   *  once (a bulk sync, an import, a delete), so clients read everything. */
  'tasks.invalidated': { taskId?: string }
  /** The caller's own task snoozes changed. Delivered only to that person's
   *  connections; they read `tasksSnoozes` again. Names nothing. */
  'tasks.snoozesChanged': Record<string, never>
  'workspaceProjects.changed': Record<string, never>
  /** This host's project list changed: a folder was added, untracked or
   *  deleted, or its last use moved. Clients read `listProjects` again. */
  'projects.changed': Record<string, never>
  /** This host's outbox gained, lost, or failed an op. Connected clients react
   *  by draining (`outboxList` → apply on the owner host → `outboxAck`). */
  'outbox.changed': Record<string, never>
  /** PR sync saw a pull request change, or a write changed one. Carries only
   *  what changed. */
  'pr.changed': PrSyncChange
  'annotations.changed': AnnotationsChanged
  /** One work was created or changed, after the write committed. `version` is
   *  the record version (`updatedAt`, the HTTP ETag); `contentVersion` is the
   *  body's own version. No content: a reader that needs the body reads the
   *  work by id. Delivered only to principals that can open the work.
   *  `deleted` marks the work's deletion; the versions are its last ones. */
  'works.changed': { workId: string; version: string; contentVersion: number; deleted?: true }
  /** One work's reviewers or decisions changed. Delivered to everyone who can
   *  open the work; the review is read again with `workReviewGet`. */
  'workReviews.changed': WorkReviewsChanged
  /** The caller's own notifications changed at this home. Delivered only to the
   *  recipient's connections; they read the first page again. */
  'notifications.changed': NotificationsChanged
  /** Live editing: sent only to the clients in the work's room, never stored as events. */
  'workLive.update': WorkLiveUpdateEvent
  'workLive.awareness': WorkLiveAwarenessEvent
  'workLive.state': WorkLiveStateEvent
  'attention.snapshotChanged': { entries: AttentionEntry[] }
  'pr.guideStatusChanged': PrGuideStatusEvent
  'usage.limitsChanged': { snapshots: AgentUsageLimits[] }
  /** A turn's row in the Insights record was written: open when the turn
   *  starts, finished when it ends. Sent after the write, so a client that reads
   *  on it sees the new row. `status` is 'unknown' while the turn runs. */
  'metrics.turnsChanged': { traceId: string; sessionId: string | null; status: 'ok' | 'error' | 'interrupted' | 'unknown' }
  /** A pull of turns other hosts ran started or ended (docs/plans/insights-across-hosts.md). */
  'metrics.insightPullChanged': InsightPullState
  /** An agent tool found a connection missing and its turn is waiting on it.
   *  One event for every provider: the card, the dismissal, and the continue
   *  are the same work regardless of which account is missing. */
  'connection.connectNeeded': ConnectionConnectNeeded
  /** One browser page's server-owned state changed. Per-page rather than a full
   *  list: a page changes on every navigation, and the list is unbounded. */
  'browser.pageChanged': { page: BrowserPage }
  'browser.pageClosed': { browserPageId: string }
  /** A page has no surface and someone explicitly asked for one — an agent
   *  calling `browserOpen` with `requestSurface`. Desktop clients answer by
   *  opening the browser pane onto that page. */
  'browser.surfaceRequested': { browserPageId: string }
  /** One project's named browser profiles changed. Whole set rather than a
   *  delta: the list is a handful of rows, and two mounted clients offering
   *  different identities for one project is the failure to avoid. */
  'browser.profilesChanged': { profiles: BrowserProfileSet }
  /** The whole device snapshot. Bounded: hosts, devices and previews are capped. A
   *  client that sees a revision lower than one it holds ignores it; after a
   *  reconnect it reads `deviceState`. Never carries frames or credentials. */
  'device.stateChanged': { state: DeviceState }
  /** An agent or user opened a device in a session; clients showing that session may reveal it. */
  'device.surfaceRequested': { sessionId: string; devicePreviewId: string; openedBy: 'user' | 'agent' }
  'atlassian.oauthCompleted': AtlassianOAuthCompleted
  /** This host's config changed. Every mounted client adopts it, so two
   *  windows or two devices cannot end a turn showing different settings. */
  'config.changed': HostConfigSnapshot
  /** A project's code-intelligence indexes changed state on this host. */
  'codeIntel.statusChanged': CodeIntelStatus
  /** This host's Solus or provider update check changed. The whole status: it
   *  is a handful of fields, and a diff would be more code than the payload. */
  'host.updateStatusChanged': HostUpdateStatus
  /** This host's model list changed, or a check of GitHub started or ended. The
   *  whole status: clients put the list in effect as soon as it arrives. */
  'host.modelProfilesChanged': ModelProfilesStatus
  /** A session's or work's owner or share list changed. Sent to everyone who could
   *  see it before or after; the list itself is re-read with `shareGet`. */
  'share.changed': ShareChangedEvent
  /** One member's seat for one provider changed state. Delivered to that member's
   *  clients only; the list is re-read with `seatList`. */
  'host.seatChanged': SeatChangedEvent
  /** A Claude Design or MCP server sign-in ended. Delivered to the clients of the seat that started it. */
  'host.agentAuthFinished': AgentAuthFinishedEvent
  /** An integration was created, updated, or removed, or its tool list changed. Read it again by id. */
  'integration.changed': IntegrationChangedEvent
  /** Who is watching one session, and whose turn is running. The whole room each
   *  time: a handful of rows, and two clients disagreeing about who is present is
   *  the failure to avoid. Delivered to the session's watchers. */
  'session.presenceChanged': SessionPresenceSnapshot
  /** Who is connected to this host and what each of them has focused. Delivered to
   *  every admitted client but a guest, who is never told about the host. */
  'host.presenceChanged': HostPresenceSnapshot
  /** Who has one work open. Delivered to the guests on that work's link, who
   *  never get the host room. */
  'work.presenceChanged': WorkPresenceSnapshot
  /** This host's cloud link changed: linked, unlinked, or the tunnel came up or
   *  went down. The whole status, as `uplinkStatus` answers it: linking returns
   *  before the connector registers, so the row that just linked hears "online" here. */
  'host.uplinkStatusChanged': UplinkStatus
  /** This host's standing changed: linked or unlinked, an organization shared or withdrawn, a policy edited, an opt-in
   *  changed. The whole status, as `hostOrganizations` answers it. */
  'host.organizationsChanged': HostOrganizationsStatus
}

export type HostEventName = keyof HostEventMap

/** A distributive union that preserves each event name's payload type. */
export type HostEvent<K extends HostEventName = HostEventName> =
  K extends HostEventName
    ? { type: K; payload: HostEventMap[K]; occurredAt: number }
    : never

export interface HostEventDefinition {
  owner: string
  category: 'invalidation' | 'delta' | 'snapshot' | 'stream' | 'targeted'
  recovery: 'reload' | 'backfill' | 'reset'
  description: string
}

/** Runtime catalog for boundary validation and human discovery. */
export const HOST_EVENT_DEFINITIONS = {
  'git.checkoutChanged': { owner: 'git', category: 'delta', recovery: 'reload', description: 'Checkout identity changed; recover through checkoutSnapshot.' },
  'session.eventReceived': { owner: 'sessions', category: 'targeted', recovery: 'reset', description: 'A normalized provider event arrived for a watched session.' },
  'session.errorReceived': { owner: 'sessions', category: 'targeted', recovery: 'reset', description: 'An enriched provider error arrived for a watched session.' },
  'session.indexChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'A provider session index changed.' },
  'session.titleChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'A persisted session title changed.' },
  'session.pullRequestsChanged': { owner: 'sessions', category: 'invalidation', recovery: 'reload', description: "A session's pull request links changed." },
  'session.stateChanged': { owner: 'sessions', category: 'invalidation', recovery: 'reload', description: 'A session was settled, made active, snoozed or woken.' },
  'session.transcriptChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'The cloud transcript changed.' },
  'session.statusChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'A provider session changed live status.' },
  'session.readStateChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'A session was read or returned to unread on some client.' },
  'setup.statusChanged': { owner: 'setup', category: 'targeted', recovery: 'reset', description: 'A host setup step changed status.' },
  'setup.logAppended': { owner: 'setup', category: 'stream', recovery: 'reset', description: 'A host setup step appended output.' },
  'voice.modelStatusChanged': { owner: 'voice', category: 'snapshot', recovery: 'reload', description: 'The host voice model changed status.' },
  'automation.changed': { owner: 'automations', category: 'delta', recovery: 'reload', description: 'A durable automation or its run state changed.' },
  'provider.deviceCodeReceived': { owner: 'providers', category: 'targeted', recovery: 'reset', description: 'A provider sign-in produced a device code.' },
  'git.actionProgressed': { owner: 'git', category: 'targeted', recovery: 'reset', description: 'A stacked Git action changed phase.' },
  'review.progressChanged': { owner: 'review', category: 'delta', recovery: 'reload', description: 'Review generation progress changed.' },
  'review.guideStatusChanged': { owner: 'review', category: 'delta', recovery: 'reload', description: 'A review guide changed status.' },
  'review.lensChanged': { owner: 'review', category: 'delta', recovery: 'reload', description: 'A review lens, its comments, or its job changed.' },
  'tasks.invalidated': { owner: 'tasks', category: 'invalidation', recovery: 'reload', description: 'The local task store changed.' },
  'tasks.snoozesChanged': { owner: 'tasks', category: 'invalidation', recovery: 'reload', description: "The recipient's own task snoozes changed; read them again." },
  'workspaceProjects.changed': { owner: 'projects', category: 'invalidation', recovery: 'reload', description: "The organization's project directory changed." },
  'projects.changed': { owner: 'projects', category: 'invalidation', recovery: 'reload', description: "This host's project list changed." },
  'outbox.changed': { owner: 'outbox', category: 'invalidation', recovery: 'reload', description: 'The host outbox changed; connected clients should drain it.' },
  'pr.changed': { owner: 'prs', category: 'delta', recovery: 'reload', description: 'PR sync saw pull requests, checks, or review requests change in one repository.' },
  'annotations.changed': { owner: 'annotations', category: 'delta', recovery: 'reload', description: 'Plan or work annotations changed.' },
  'works.changed': { owner: 'works', category: 'delta', recovery: 'reload', description: 'A work was created, deleted, or its record or content changed; read it again by id.' },
  'workLive.update': { owner: 'works', category: 'targeted', recovery: 'reset', description: 'A Yjs update to a work open live; the room applies it. A client that missed one opens the work again.' },
  'workLive.awareness': { owner: 'works', category: 'targeted', recovery: 'reset', description: "A cursor in a work open live moved, or a client left its room." },
  'workLive.state': { owner: 'works', category: 'targeted', recovery: 'reset', description: 'The agent edit lock on a work open live started or ended.' },
  'workReviews.changed': { owner: 'works', category: 'delta', recovery: 'reload', description: "A work's reviewers or review decisions changed; read the review again by work id." },
  'notifications.changed': { owner: 'notifications', category: 'invalidation', recovery: 'reload', description: "The recipient's notifications changed; read the first page again." },
  'attention.snapshotChanged': { owner: 'attention', category: 'snapshot', recovery: 'reload', description: 'The bounded attention list changed.' },
  'pr.guideStatusChanged': { owner: 'prs', category: 'delta', recovery: 'reload', description: 'A pull-request guide changed status.' },
  'usage.limitsChanged': { owner: 'usage', category: 'snapshot', recovery: 'reload', description: 'Provider subscription quota changed.' },
  'metrics.turnsChanged': { owner: 'metrics', category: 'delta', recovery: 'reload', description: "A turn's Insights row was written: started or finished." },
  'metrics.insightPullChanged': { owner: 'metrics', category: 'snapshot', recovery: 'reload', description: 'A pull of turns other hosts ran started or ended.' },
  'connection.connectNeeded': { owner: 'connections', category: 'delta', recovery: 'reset', description: 'An agent tool needs the user to connect an external account.' },
  'browser.pageChanged': { owner: 'browser', category: 'delta', recovery: 'reload', description: 'A browser page changed target, viewport, host, or load state.' },
  'browser.pageClosed': { owner: 'browser', category: 'delta', recovery: 'reload', description: 'A browser page was closed.' },
  'browser.surfaceRequested': { owner: 'browser', category: 'targeted', recovery: 'reset', description: 'A browser page was explicitly asked to be given a client surface.' },
  'browser.profilesChanged': { owner: 'browser', category: 'snapshot', recovery: 'reload', description: "A project's named browser profiles changed." },
  'device.stateChanged': { owner: 'devices', category: 'snapshot', recovery: 'reload', description: 'Device inventory, helper status, previews or control changed; the payload is the bounded snapshot.' },
  'device.surfaceRequested': { owner: 'devices', category: 'targeted', recovery: 'reset', description: 'A device was opened in a session and its surface may be revealed.' },
  'atlassian.oauthCompleted': { owner: 'atlassian', category: 'delta', recovery: 'reload', description: 'An Atlassian browser sign-in finished on this host.' },
  'config.changed': { owner: 'config', category: 'snapshot', recovery: 'reload', description: 'This host config changed; every mounted client adopts the snapshot.' },
  'codeIntel.statusChanged': { owner: 'code-intel', category: 'snapshot', recovery: 'reload', description: 'A project code-intelligence index started, finished, failed, or went stale.' },
  'host.updateStatusChanged': { owner: 'updates', category: 'snapshot', recovery: 'reload', description: 'The host Solus release check or a provider release check changed state.' },
  'host.modelProfilesChanged': { owner: 'model-profiles', category: 'snapshot', recovery: 'reload', description: "This host's model list or its GitHub check changed state." },
  'share.changed': { owner: 'sharing', category: 'delta', recovery: 'reload', description: "A session's or work's owner or share list changed." },
  'host.seatChanged': { owner: 'seats', category: 'delta', recovery: 'reload', description: "A member's provider seat on this host changed state." },
  'host.agentAuthFinished': { owner: 'seats', category: 'targeted', recovery: 'reset', description: 'A Claude Design or MCP server sign-in in one seat ended.' },
  'integration.changed': { owner: 'integrations', category: 'invalidation', recovery: 'reload', description: 'An integration or its tool list changed; read it again by id.' },
  'session.presenceChanged': { owner: 'presence', category: 'snapshot', recovery: 'reload', description: 'The people watching a session, or its active turn, changed.' },
  'work.presenceChanged': { owner: 'presence', category: 'snapshot', recovery: 'reload', description: 'The people who have one work open, or what they do there, changed.' },
  'host.presenceChanged': { owner: 'presence', category: 'snapshot', recovery: 'reload', description: 'The people connected to this host, or what they have focused, changed.' },
  'host.uplinkStatusChanged': { owner: 'uplink', category: 'snapshot', recovery: 'reload', description: "This host's cloud link or its tunnel changed state." },
  'host.organizationsChanged': { owner: 'uplink', category: 'snapshot', recovery: 'reload', description: "This host's organizations, their policies, or its Insights opt-ins changed." },
} as const satisfies Record<HostEventName, HostEventDefinition>

const hostEventEnvelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
  occurredAt: z.number(),
})

export function isHostEvent(value: z.input<typeof hostEventEnvelopeSchema>): value is HostEvent {
  const parsed = hostEventEnvelopeSchema.safeParse(value)
  return parsed.success && parsed.data.type in HOST_EVENT_DEFINITIONS
}
