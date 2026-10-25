import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { serverConnections } from '@solus/client-core/server-connections'
import { serverFromSshAdd } from '@solus/client-core/server-registry'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import type { SshAddProgress } from '@solus/contracts/remote-machines'
import { hosts, serversStore, uplinkStore } from '../../contexts'
import { requestInputFocus } from '../../lib/inputFocus'
import { sshAddOutcome, sshAddRequest } from './lib/add-over-ssh'
import { messageFor } from './lib/setup-rpc'

/** `form` waits on the person; `running` waits on the host; `done` shows the result. */
export type AddOverSshPhase = 'form' | 'running' | 'done'

/**
 * "Add a machine over SSH" for a machine that was not discovered (docs/plans/host-routes.md
 * D6). The SSH runs on this client's own machine when it has one (the desktop), else on
 * the host the client is connected to (web): that host holds the SSH keys and the forward.
 */
class AddOverSshStore {
  isOpen = $state(false)
  sshTarget = $state('')
  linkToAccount = $state(false)
  password = $state('')
  phase = $state<AddOverSshPhase>('form')
  /** The steps of the add in flight, as the host reports them. */
  progress = $state<SshAddProgress[]>([])
  /** The inline error of the form, or empty. */
  error = $state('')
  /** What the add did, once it is done. */
  resultMessage = $state('')
  /** SSH refused the key and the host links, so the password field is the next thing to fill. */
  isPasswordRequested = $state(false)
  /** Bumped per attempt so an answer to a closed or superseded attempt is dropped. */
  private attempt = 0
  /** The host a host's own settings page named; null for this client's default. */
  private chosenHostId = $state<string | null>(null)

  /** The host the SSH runs on, or null when this client has no host. */
  get sshHostId(): string | null {
    return this.chosenHostId ?? (hosts.device ?? hosts.runOn)?.id ?? null
  }

  get sshHostName(): string {
    const hostId = this.sshHostId
    return (hostId && serversStore.hostFor(hostId)?.label) || 'the connected host'
  }

  /** An account can issue the link ticket. */
  get canLink(): boolean {
    return uplinkStore.canLink
  }

  get canSubmit(): boolean {
    return this.phase === 'form' && !!this.sshTarget.trim() && !!this.sshHostId
  }

  /** `sshHostId` names the host that runs the SSH and holds the forward; omitted, this client's default. */
  open(sshHostId: string | null = null): void {
    this.attempt++
    this.chosenHostId = sshHostId
    this.sshTarget = ''
    this.password = ''
    this.linkToAccount = this.canLink
    this.phase = 'form'
    this.progress = []
    this.error = ''
    this.resultMessage = ''
    this.isPasswordRequested = false
    this.isOpen = true
  }

  /** An add in flight still lands after a close: the host finishes it, and its host is saved. */
  close(): void {
    this.isOpen = false
    this.password = ''
    requestInputFocus()
  }

  setLinkToAccount(next: boolean): void {
    this.linkToAccount = next && this.canLink
    if (!this.linkToAccount) {
      this.password = ''
      this.isPasswordRequested = false
    }
  }

  async submit(): Promise<void> {
    const hostId = this.sshHostId
    if (!this.canSubmit || !hostId) return
    const attempt = ++this.attempt
    const requestId = crypto.randomUUID()
    const linkToAccount = this.linkToAccount
    const password = this.password
    this.password = ''
    this.phase = 'running'
    this.progress = []
    this.error = ''
    this.isPasswordRequested = false
    const stopProgress = serverConnections.eventsFor(hostId).subscribe('host.sshProgress', (event) => {
      if (event.requestId === requestId && attempt === this.attempt) this.progress.push(event)
    })
    try {
      let link = null
      if (linkToAccount) {
        link = (await uplinkAccountSource()?.issueEnrollmentTicket()) ?? null
        if (!link) throw new Error('Solus Cloud did not give a link ticket. Sign in and try again.')
      }
      const request = sshAddRequest(
        { sshTarget: this.sshTarget, linkToAccount, password, deviceLabel: defaultDeviceLabel(), requestId },
        link,
      )
      const result = await serverConnections.apiFor(hostId).hostsAddOverSsh(request)
      if (attempt !== this.attempt) return
      const outcome = sshAddOutcome(result, {
        linkToAccount,
        sshHostIsThisMachine: hostId === hosts.device?.id,
        sshHostName: this.sshHostName,
      })
      switch (outcome.kind) {
        case 'save-forwarded':
          // Narrowed by the outcome: only a forwarded answer is saved here.
          if (result.status === 'forwarded') serversStore.savePairedServer(serverFromSshAdd(result, null))
          break
        case 'linked':
          void serversStore.refreshDirectory()
          break
        case 'ask-password':
          this.isPasswordRequested = true
          break
      }
      if (outcome.kind === 'save-forwarded' || outcome.kind === 'forwarded-elsewhere' || outcome.kind === 'linked') {
        this.resultMessage = outcome.message
        this.phase = 'done'
        return
      }
      this.error = outcome.message
      this.phase = 'form'
    } catch (err) {
      if (attempt !== this.attempt) return
      this.error = messageFor(err)
      this.phase = 'form'
    } finally {
      stopProgress()
    }
  }
}

export const addOverSshStore = new AddOverSshStore()
