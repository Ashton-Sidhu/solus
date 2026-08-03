import type { AttentionEntry } from './attention-types'
import type { PrChecksSnapshot } from './checks-rpc-types'
import type { ReviewGuideStatusEvent, ReviewProgressEvent, PrGuideStatusEvent } from './review'
import type { StackGraph } from './stack-types'
import type {
  AgentUsageLimits,
  AnnotationsChanged,
  AutomationsChangedEvent,
  DeviceCodePrompt,
  EnrichedError,
  NormalizedEvent,
  RunLogBatch,
  RunStatus,
  SessionIndexUpdatedEvent,
  SessionScanEvent,
  SessionStatus,
  SessionTitleChangedEvent,
  SetupLogEvent,
  SetupStatusEvent,
  VoiceModelStatus,
} from './types'

/**
 * Canonical contract for facts published by one Solus host to its clients.
 * Commands and queries remain RPC methods; native shell signals stay local.
 */
export interface HostEventMap {
  'session.eventReceived': { tabId: string; event: NormalizedEvent }
  'session.errorReceived': { tabId: string; error: EnrichedError }
  'session.scanProgressed': SessionScanEvent
  'session.indexChanged': SessionIndexUpdatedEvent
  'session.titleChanged': SessionTitleChangedEvent
  'session.statusChanged': { sessionId: string; status: SessionStatus; at: number }
  'run.statusChanged': RunStatus
  'run.logAppended': RunLogBatch
  'setup.statusChanged': SetupStatusEvent
  'setup.logAppended': SetupLogEvent
  'voice.modelStatusChanged': VoiceModelStatus
  'automation.changed': AutomationsChangedEvent
  'provider.deviceCodeReceived': DeviceCodePrompt
  'review.progressChanged': ReviewProgressEvent
  'review.guideStatusChanged': ReviewGuideStatusEvent
  'tasks.invalidated': { projectRoot: string }
  'prs.invalidated': { projectRoot: string }
  'annotations.changed': AnnotationsChanged
  'attention.snapshotChanged': { entries: AttentionEntry[] }
  'stack.graphChanged': { repoRoot: string; graph: StackGraph }
  'pr.checksChanged': PrChecksSnapshot
  'pr.guideStatusChanged': PrGuideStatusEvent
  'usage.limitsChanged': { snapshots: AgentUsageLimits[] }
  'cloudflare.connectNeeded': { reason: 'deploy' }
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
  'session.eventReceived': { owner: 'sessions', category: 'targeted', recovery: 'reset', description: 'A normalized provider event arrived for an owned tab.' },
  'session.errorReceived': { owner: 'sessions', category: 'targeted', recovery: 'reset', description: 'An enriched provider error arrived for an owned tab.' },
  'session.scanProgressed': { owner: 'sessions', category: 'targeted', recovery: 'reset', description: 'A requested session scan produced progress.' },
  'session.indexChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'A provider session index changed.' },
  'session.titleChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'A persisted session title changed.' },
  'session.statusChanged': { owner: 'sessions', category: 'delta', recovery: 'reload', description: 'A provider session changed live status.' },
  'run.statusChanged': { owner: 'run', category: 'snapshot', recovery: 'reload', description: 'A run command changed status.' },
  'run.logAppended': { owner: 'run', category: 'stream', recovery: 'backfill', description: 'A run command appended output.' },
  'setup.statusChanged': { owner: 'setup', category: 'targeted', recovery: 'reset', description: 'A host setup step changed status.' },
  'setup.logAppended': { owner: 'setup', category: 'stream', recovery: 'reset', description: 'A host setup step appended output.' },
  'voice.modelStatusChanged': { owner: 'voice', category: 'snapshot', recovery: 'reload', description: 'The host voice model changed status.' },
  'automation.changed': { owner: 'automations', category: 'delta', recovery: 'reload', description: 'A durable automation or its run state changed.' },
  'provider.deviceCodeReceived': { owner: 'providers', category: 'targeted', recovery: 'reset', description: 'A provider sign-in produced a device code.' },
  'review.progressChanged': { owner: 'review', category: 'delta', recovery: 'reload', description: 'Review generation progress changed.' },
  'review.guideStatusChanged': { owner: 'review', category: 'delta', recovery: 'reload', description: 'A review guide changed status.' },
  'tasks.invalidated': { owner: 'tasks', category: 'invalidation', recovery: 'reload', description: 'A task mutation committed for one project.' },
  'prs.invalidated': { owner: 'prs', category: 'invalidation', recovery: 'reload', description: 'Pull-request state changed for one project.' },
  'annotations.changed': { owner: 'annotations', category: 'delta', recovery: 'reload', description: 'Plan or work annotations changed.' },
  'attention.snapshotChanged': { owner: 'attention', category: 'snapshot', recovery: 'reload', description: 'The bounded attention list changed.' },
  'stack.graphChanged': { owner: 'stacks', category: 'snapshot', recovery: 'reload', description: 'A repository PR stack graph changed.' },
  'pr.checksChanged': { owner: 'prs', category: 'snapshot', recovery: 'reload', description: 'Cached pull-request checks changed.' },
  'pr.guideStatusChanged': { owner: 'prs', category: 'delta', recovery: 'reload', description: 'A pull-request guide changed status.' },
  'usage.limitsChanged': { owner: 'usage', category: 'snapshot', recovery: 'reload', description: 'Provider subscription quota changed.' },
  'cloudflare.connectNeeded': { owner: 'cloudflare', category: 'delta', recovery: 'reset', description: 'A Cloudflare-backed agent tool needs the user to connect a profile.' },
} as const satisfies Record<HostEventName, HostEventDefinition>

export function isHostEvent(value: unknown): value is HostEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; payload?: unknown; occurredAt?: unknown }
  return typeof candidate.type === 'string'
    && candidate.type in HOST_EVENT_DEFINITIONS
    && 'payload' in candidate
    && typeof candidate.occurredAt === 'number'
}
