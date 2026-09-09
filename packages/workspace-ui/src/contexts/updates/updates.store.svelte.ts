import { localApi } from '@solus/client-core/local-api'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { DesktopUpdateRelease, DesktopUpdateState, DesktopUpdateStatus } from '@solus/contracts/desktop-update-types'

type UpdatesApi = Pick<
  NativeSolusAPI,
  'updateStatus' | 'checkForUpdate' | 'downloadUpdate' | 'restartToUpdate' | 'setUpdateAutoDownload' | 'onUpdateStatusChange'
>

/** A prompt the shell owes the user for the current release. */
export type UpdatePrompt = 'download' | 'restart'

const IDLE: DesktopUpdateState = { kind: 'idle' }

/**
 * Mirrors the desktop update status the client shell owns. On desktop the main
 * process runs the checks and pushes every change here; on web and mobile there
 * is no shell capability, so `isAvailable` is false and no update surface
 * renders. This store carries no UI of its own: the gear dot, Settings, the
 * palette, and the shell's toasts read it and call its commands.
 * `docs/plans/desktop-updates.md`.
 */
export class UpdatesStore {
  status = $state<DesktopUpdateStatus | null>(null)
  /** True when the client shell can update itself (desktop today). */
  readonly isAvailable: boolean
  private readonly api: Partial<UpdatesApi>
  private hasStarted = false
  // Each prompt is owed once per release. Holding the version, not a flag,
  // means a status re-broadcast for the same release never re-arms it.
  private promptedDownloadVersion = $state<string | null>(null)
  private promptedRestartVersion = $state<string | null>(null)
  private manualCheckPending = $state(false)

  constructor(api: Partial<UpdatesApi> = localApi) {
    this.api = api
    this.isAvailable = api.updateStatus !== undefined
  }

  /** Subscribes once; safe to call from every surface that renders update state. */
  start(): void {
    if (this.hasStarted || !this.isAvailable) return
    this.hasStarted = true
    this.api.onUpdateStatusChange?.((status) => {
      this.status = status
    })
    void this.api.updateStatus?.().then((status) => {
      this.status = status
    })
  }

  get state(): DesktopUpdateState {
    return this.status?.state ?? IDLE
  }

  get currentVersion(): string | null {
    return this.status?.currentVersion ?? null
  }

  get autoDownload(): boolean {
    return this.status?.autoDownload ?? true
  }

  /** The release the state is about, when it is about one. */
  get release(): DesktopUpdateRelease | null {
    const state = this.state
    return 'release' in state ? state.release : null
  }

  get isReady(): boolean {
    return this.state.kind === 'ready'
  }

  /**
   * The prompt the shell should show next, or null. A download prompt is owed
   * only while auto-download is off; with it on, the download needs no answer.
   * The shell decides *when* to show it (never mid-turn) and then calls
   * {@link markPromptShown}.
   */
  get pendingPrompt(): UpdatePrompt | null {
    const state = this.state
    if (state.kind === 'available' && !this.autoDownload && state.release.version !== this.promptedDownloadVersion) {
      return 'download'
    }
    if (state.kind === 'ready' && state.release.version !== this.promptedRestartVersion) return 'restart'
    return null
  }

  markPromptShown(prompt: UpdatePrompt): void {
    const version = this.release?.version ?? null
    if (prompt === 'download') this.promptedDownloadVersion = version
    else this.promptedRestartVersion = version
  }

  /**
   * How the last check the user asked for ended, until the shell reports it.
   * A background check that finds nothing or fails stays silent; only a check
   * the user started earns a toast.
   */
  get manualCheckOutcome(): 'up-to-date' | 'error' | null {
    if (!this.manualCheckPending) return null
    const kind = this.state.kind
    return kind === 'up-to-date' || kind === 'error' ? kind : null
  }

  markManualCheckReported(): void {
    this.manualCheckPending = false
  }

  async check(): Promise<void> {
    this.manualCheckPending = true
    await this.api.checkForUpdate?.()
  }

  async download(): Promise<void> {
    await this.api.downloadUpdate?.()
  }

  /** Quits and installs now. Callers on a visible control may run this mid-turn;
   *  the shell's prompt never does. */
  restart(): void {
    this.api.restartToUpdate?.()
  }

  async setAutoDownload(enabled: boolean): Promise<void> {
    await this.api.setUpdateAutoDownload?.(enabled)
  }
}

export const updatesStore = new UpdatesStore()
