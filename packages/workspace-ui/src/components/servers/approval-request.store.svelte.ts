import { discoveredServerUrl } from '../../contexts'
import { newCheckCode } from '../../lib/check-code'
import { ApprovalUnavailableError, pairWithApproval } from '../fleet/add-machine'
import type { FoundMachine } from '../fleet/lib/discover'
import { messageFor } from './lib/setup-rpc'

export type FoundServer = Extract<FoundMachine, { kind: 'server' }>

/**
 * How one approval request stands: sent and waiting, approved, ended with a
 * reason, or refused because the machine has no approval requests (an older
 * Solus), where only a pairing code helps.
 */
export type ApprovalPhase = 'idle' | 'waiting' | 'added' | 'failed' | 'unavailable'

/**
 * The one approval request this client sends to a machine it found: a pairing
 * with no code, which that machine's owner approves after comparing the check
 * code. The Add host dialog shows it, and the machine's card on the host map
 * says it waits. A machine found on Tailscale pairs as a Tailscale route.
 */
class ApprovalRequestStore {
  machine = $state<FoundServer | null>(null)
  phase = $state<ApprovalPhase>('idle')
  /** The code both machines show while the request waits; null otherwise. */
  checkCode = $state<string | null>(null)
  /** Why the request ended without a pairing. */
  message = $state<string | null>(null)
  #controller: AbortController | null = null

  /** The address the request goes to, for the dialog's Code tab. */
  get url(): string | null {
    return this.machine ? discoveredServerUrl(this.machine.server) : null
  }

  /** Sends a request to `machine`, after ending any request that still waits. */
  async start(machine: FoundServer): Promise<void> {
    this.#controller?.abort()
    const controller = new AbortController()
    this.#controller = controller
    this.machine = machine
    this.phase = 'waiting'
    this.message = null
    // The code shows before the request goes, so the person can compare it at once.
    this.checkCode = newCheckCode()
    try {
      await pairWithApproval(discoveredServerUrl(machine.server), this.checkCode, () => {}, controller.signal, machine.source === 'tailnet')
      if (this.#controller !== controller) return
      this.phase = 'added'
    } catch (error) {
      if (this.#controller !== controller) return
      if (controller.signal.aborted) {
        this.phase = 'idle'
        this.message = null
      } else if (error instanceof ApprovalUnavailableError) {
        this.phase = 'unavailable'
        this.message = `${machine.name} runs an older Solus. Use a pairing code.`
      } else {
        this.phase = 'failed'
        this.message = messageFor(error)
      }
    } finally {
      if (this.#controller === controller) {
        this.#controller = null
        this.checkCode = null
      }
    }
  }

  /** Ends a request that still waits; the machine stays named, so Ask again can send another. */
  stop(): void {
    this.#controller?.abort()
  }

  /** Forgets the request, ending it if it still waits. */
  clear(): void {
    this.stop()
    this.machine = null
    this.phase = 'idle'
    this.message = null
  }
}

export const approvalRequestStore = new ApprovalRequestStore()

/** What a surface reads of the request and may do with it. */
export type ApprovalRequest = Pick<ApprovalRequestStore, 'machine' | 'phase' | 'checkCode' | 'message' | 'stop'>
