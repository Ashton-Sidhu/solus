import { HostSupervisor } from '@solus/client-core/host-supervisor'
import { WsTransport } from '@solus/client-core/ws-transport'
import { createLogger } from '../logger'
import type { SessionRuntime } from '../execution/session-runtime'
import type { RunnerDelivery } from '../sync/runner-delivery'
import type { DeliveryDestination } from '../sync/outbox/outbox-store'
import { getSessionRecord } from '../data/sessions/session-records'
import { ANY_ORGANIZATION, GUEST_DEVICE_LABEL, type Principal } from '../admission/principal'
import type { Actor } from '../admission/actor'
import { parseUserKey } from '@solus/contracts/user'
import { SHARED_PROMPT_EVENT, sharedPromptCommandSchema, type SharedPromptCommand, type SharedPromptReceipt } from './shared-prompt'

const log = createLogger('main', 'shared-prompt-runner')

/** How often the sockets are matched to the link and its organizations, besides after every delivery pass. */
const RECONCILE_MS = 15_000

interface RunnerSocket {
  transport: WsTransport
  supervisor: HostSupervisor
  /** What the socket was opened for; a change to any of them opens a new one. */
  identity: string
}

/**
 * Only the authenticated Solus API assigns work, and only for a session of the
 * organization the socket is admitted under: a runner holds one socket to the API
 * for each organization it acts for someone in (plans/010-standard-oauth.md),
 * admitted with that person's delegated token, and a command names a session that
 * belongs to that organization. The API sends a command down the socket and waits
 * for the runner's receipt. The socket is the same client transport and supervisor
 * a host dials another host with (`RemoteHosts`). The runner never admits guest
 * sockets or accepts caller-supplied provider settings or paths.
 */
export function startSharedPromptRunner(delivery: RunnerDelivery, sessionRuntime: SessionRuntime, hostId: () => string | null): () => void {
  let stopped = false
  const sockets = new Map<string, RunnerSocket>()

  const close = (organizationId: string) => {
    const entry = sockets.get(organizationId)
    if (!entry) return
    sockets.delete(organizationId)
    entry.supervisor.destroy()
    entry.transport.destroy()
  }

  const open = (destination: DeliveryDestination, apiUrl: string, identity: string) => {
    const organizationId = destination.organizationId
    const transport = new WsTransport({
      serverUrl: new URL(apiUrl).origin,
      // Every dial presents the person's delegated token; there is no paired credential.
      sessionToken: '',
      acquireGrant: () => delivery.accessToken(destination),
    })
    const supervisor = new HostSupervisor({
      transport,
      onPhaseChange: (phase) => log.info('shared_prompt_socket_phase', { organizationId, phase }),
    })
    transport.attachDialOutcomeReporter((outcome) => supervisor.report(outcome))
    transport.onServerRequest(SHARED_PROMPT_EVENT, sharedPromptCommandSchema, async (command): Promise<SharedPromptReceipt> => ({ error: await dispatch(command, organizationId) }), { error: 'The command was unreadable.' })
    sockets.set(organizationId, { transport, supervisor, identity })
    supervisor.start()
  }

  const dispatch = async (command: SharedPromptCommand, organizationId: string): Promise<string | null> => {
    try {
      if (command.expiresAt <= Date.now()) throw new Error('The prompt expired before dispatch.')
      const record = await getSessionRecord(ANY_ORGANIZATION, command.sessionId)
      if (!record) throw new Error('This runner does not hold the session.')
      if (record.organizationId !== organizationId) throw new Error('This session belongs to another organization.')
      // Ask mode keeps tool permission decisions with the signed-in sharer/owner.
      await sessionRuntime.dispatch.promptSession(command.sessionId, command.text, 'queue', { actor: sharedPromptActor(command, organizationId), permissionMode: 'supervised' })
      return null
    } catch (failure) {
      return failure instanceof Error ? failure.message : String(failure)
    }
  }

  /** One socket per organization while the host is linked; none otherwise. */
  const reconcile = () => {
    const linkedHostId = hostId()
    const apiUrl = delivery.apiUrl()
    const wanted = new Map<string, { destination: DeliveryDestination; identity: string }>()
    if (!stopped && linkedHostId && apiUrl) {
      for (const destination of delivery.socketTargets()) {
        wanted.set(destination.organizationId, { destination, identity: `${apiUrl}\u0000${linkedHostId}\u0000${destination.actorUserId}` })
      }
    }
    for (const [organizationId, entry] of sockets) {
      if (wanted.get(organizationId)?.identity !== entry.identity) close(organizationId)
    }
    for (const [organizationId, { destination, identity }] of wanted) {
      if (!sockets.has(organizationId)) open(destination, apiUrl!, identity)
    }
  }

  const timer = setInterval(reconcile, RECONCILE_MS)
  timer.unref()
  const unsubscribe = delivery.onCycle(reconcile)
  reconcile()
  return () => {
    stopped = true
    clearInterval(timer)
    unsubscribe()
    for (const organizationId of sockets.keys()) close(organizationId)
  }
}

/**
 * The link visitor behind a shared prompt, as the Solus API admitted them. The
 * wire names the seat by its user's key: the prompt runs on the visitor's own
 * account, or on the person who shared the link, never on the runner's login
 * unless the runner's own user shared it (plans/012 §3). The user is the one the
 * Solus API named, so the bubble reads the same on every client.
 */
function sharedPromptActor(command: SharedPromptCommand, organizationId: string): Actor {
  const author = parseUserKey(command.actor.userId)
  const principal: Extract<Principal, { kind: 'guest' }> = {
    kind: 'guest',
    organizationId,
    guestId: author.kind === 'guest' ? author.guestId : command.actor.userId,
    displayName: command.actor.displayName,
    deviceId: command.requestId,
    share: { resource: { kind: 'session', id: command.sessionId }, role: 'editor', sharedByUserId: command.actor.seatUserId, linkSecretHash: '' },
    expiresAt: command.expiresAt,
    deviceLabel: GUEST_DEVICE_LABEL,
  }
  if (author.kind === 'account') principal.accountUserId = author.accountId
  return { principal, user: { id: author, displayName: command.actor.displayName } }
}
