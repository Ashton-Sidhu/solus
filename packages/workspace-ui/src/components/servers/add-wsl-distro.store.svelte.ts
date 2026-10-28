import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { serverConnections } from '@solus/client-core/server-connections'
import { serverFromSshAdd } from '@solus/client-core/server-registry'
import type { SshAddProgress, WslDistro } from '@solus/contracts/remote-machines'
import { hosts, serversStore } from '../../contexts'
import { requestInputFocus } from '../../lib/inputFocus'
import { defaultDistro, wslAddOutcome } from './lib/add-wsl-distro'
import { messageFor } from './lib/setup-rpc'

/** `loading` reads the distros; `form` waits on the person; `running` waits on the host; `done` shows the result. */
export type AddWslPhase = 'loading' | 'form' | 'running' | 'done'

/**
 * "Add a WSL distro" (docs/plans/windows.md §13.6). The Windows host installs
 * the Linux release of its own version in the distro and forwards to it, as for
 * a machine it reaches over SSH. On the desktop that host is this computer; on
 * web it is the Windows host the client is connected to.
 */
class AddWslDistroStore {
  isOpen = $state(false)
  phase = $state<AddWslPhase>('loading')
  distros = $state<WslDistro[]>([])
  distro = $state('')
  progress = $state<SshAddProgress[]>([])
  error = $state('')
  resultMessage = $state('')
  /** Bumped per attempt so an answer to a closed or superseded attempt is dropped. */
  private attempt = 0
  /** The host a host's own settings page named; null for this client's default. */
  private chosenHostId = $state<string | null>(null)

  /** The Windows host whose distros these are, or null when this client has none. */
  get windowsHostId(): string | null {
    const hostId = this.chosenHostId ?? (hosts.device ?? hosts.runOn)?.id ?? null
    return hostId && isWindowsHost(hostId) ? hostId : null
  }

  get windowsHostName(): string {
    const hostId = this.windowsHostId
    return (hostId && serversStore.hostFor(hostId)?.label) || 'the Windows host'
  }

  get canSubmit(): boolean {
    return this.phase === 'form' && !!this.distro && !!this.windowsHostId
  }

  /** `windowsHostId` names the host whose distros to add; omitted, this client's default. */
  async open(windowsHostId: string | null = null): Promise<void> {
    const attempt = ++this.attempt
    this.chosenHostId = windowsHostId
    this.isOpen = true
    this.phase = 'loading'
    this.distros = []
    this.distro = ''
    this.progress = []
    this.error = ''
    this.resultMessage = ''
    const hostId = this.windowsHostId
    if (!hostId) {
      this.error = 'Connect to a Windows host to add its WSL distros.'
      this.phase = 'form'
      return
    }
    try {
      const listed = await serverConnections.apiFor(hostId).hostsListWslDistros()
      if (attempt !== this.attempt) return
      if (listed.status === 'ready') {
        this.distros = listed.distros
        this.distro = defaultDistro(listed.distros)
      } else {
        this.error = listed.message
      }
    } catch (err) {
      if (attempt === this.attempt) this.error = messageFor(err)
    }
    if (attempt === this.attempt) this.phase = 'form'
  }

  /** An add in flight still lands after a close: the host finishes it, and its host is saved. */
  close(): void {
    this.isOpen = false
    requestInputFocus()
  }

  async submit(): Promise<void> {
    const hostId = this.windowsHostId
    if (!this.canSubmit || !hostId) return
    const attempt = ++this.attempt
    const requestId = crypto.randomUUID()
    this.phase = 'running'
    this.progress = []
    this.error = ''
    const stopProgress = serverConnections.eventsFor(hostId).subscribe('host.sshProgress', (event) => {
      if (event.requestId === requestId && attempt === this.attempt) this.progress.push(event)
    })
    try {
      const result = await serverConnections.apiFor(hostId).hostsAddWsl({ distro: this.distro, deviceLabel: defaultDeviceLabel(), requestId })
      if (attempt !== this.attempt) return
      const outcome = wslAddOutcome(result, hostId === hosts.device?.id, this.windowsHostName)
      if (outcome.kind === 'failed') {
        this.error = outcome.message
        this.phase = 'form'
        return
      }
      if (outcome.kind === 'save-forwarded' && result.status === 'forwarded') serversStore.savePairedServer(serverFromSshAdd(result, null))
      this.resultMessage = outcome.message
      this.phase = 'done'
    } catch (err) {
      if (attempt !== this.attempt) return
      this.error = messageFor(err)
      this.phase = 'form'
    } finally {
      stopProgress()
    }
  }
}

/** The host runs Windows, so it can have WSL distros. A host known only by id has no system to read. */
export function isWindowsHost(hostId: string): boolean {
  const host = serversStore.hostFor(hostId)
  return !!host && 'os' in host && host.os === 'windows'
}

export const addWslDistroStore = new AddWslDistroStore()
