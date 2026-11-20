import { isSessionBusyStatus, type SessionStatus } from '@solus/contracts/types'
import { sessionCloudStateText, type SessionCloudState } from '@solus/client-core/session-cloud-state'

/**
 * The host control of a started session on the phone
 * (docs/plans/portable-sessions.md §10): which hosts can run the next prompt,
 * whether the choice is open now, and the state of the host with the newest
 * turn and of the cloud. Desktop and web draw the same rule as Run on under
 * the composer.
 */

export interface RunHostChoice {
  hostId: string
  label: string
  /** Connected now: the host can take a sync and a prompt. */
  isReady: boolean
  /** Past its grace and not back: the host is offline. */
  isAway: boolean
}

export interface RunHostRowInput {
  runHostId: string
  /** The host knows the session: only a started session changes its host here. */
  isStarted: boolean
  mayDrive: boolean
  status: SessionStatus
  backgroundWorkRunning: boolean
  /** A prompt this device holds that the host has not taken yet. */
  hasUnsentPrompts: boolean
  /** Files uploaded to the run host, or uploading, for the next prompt. */
  hasAttachments: boolean
  hosts: readonly RunHostChoice[]
  /** The host with the newest turn, from the facts; null when none is known. */
  newestHostId: string | null
  /** The cloud state of the session on the run host (`sessionCloudState`); null signed out or none. */
  cloudState?: SessionCloudState | null
}

export interface RunHostRowView {
  /** Another host can be chosen. */
  isShown: boolean
  /** A turn runs, a prompt waits for its host, or files wait for the next prompt: the host stays. */
  isLocked: boolean
  runHostLabel: string
  /** The host with the newest turn is offline: "<host> is offline". */
  offlineHostLabel: string | null
  /** Another connected host runs a turn of the session now: the next prompt goes there. */
  runningHostId: string | null
  /** The cloud state's words for the row: "Running on <host>" or "Not synced yet". */
  cloudNote: string | null
  /** The cloud refused the run host's push: the words of the refused-push card. */
  pushRefusedText: string | null
  /** The run host is offline, and another host can take the session: the
   *  composer stays, so the person can type and choose that host. */
  keepsComposerWhileAway: boolean
  choices: readonly RunHostChoice[]
}

export function runHostRowView(input: RunHostRowInput): RunHostRowView {
  const runHost = input.hosts.find((host) => host.hostId === input.runHostId)
  const isShown = input.isStarted && input.mayDrive
    && input.hosts.some((host) => host.hostId !== input.runHostId && host.isReady)
  const labelOf = (hostId: string | null) => input.hosts.find((host) => host.hostId === hostId)?.label ?? 'another host'
  const cloud = cloudRowFacts(input.cloudState ?? null, labelOf)
  const { runningHostId } = cloud
  // One turn at a time for each session (plan §4 decision 5): a turn on any host keeps the host.
  const isLocked = isSessionBusyStatus(input.status) || input.backgroundWorkRunning
    || input.hasUnsentPrompts || input.hasAttachments || runningHostId !== null
  const newest = input.newestHostId ? input.hosts.find((host) => host.hostId === input.newestHostId) : undefined
  return {
    isShown,
    isLocked,
    runHostLabel: runHost?.label ?? 'This host',
    offlineHostLabel: newest?.isAway ? newest.label : null,
    ...cloud,
    keepsComposerWhileAway: isShown && runHost?.isAway === true && newest !== undefined,
    choices: input.hosts,
  }
}

/** What the row takes from the cloud state: who runs a turn, and its words. */
function cloudRowFacts(state: SessionCloudState | null, labelOf: (hostId: string | null) => string): Pick<RunHostRowView, 'runningHostId' | 'cloudNote' | 'pushRefusedText'> {
  if (!state) return { runningHostId: null, cloudNote: null, pushRefusedText: null }
  const text = sessionCloudStateText(state, labelOf)
  if (state.kind === 'push-refused') return { runningHostId: null, cloudNote: null, pushRefusedText: text }
  return { runningHostId: state.kind === 'running-elsewhere' ? state.runningServerId : null, cloudNote: text, pushRefusedText: null }
}

/** What the composer row says beside the host control: "Running on <host>"
 *  first, then "<host> is offline", then "Not synced yet", as desktop says. */
export function runHostRowNote(view: RunHostRowView): string | null {
  if (view.runningHostId && view.cloudNote) return view.cloudNote
  if (view.offlineHostLabel) return `${view.offlineHostLabel} is offline`
  return view.cloudNote
}
