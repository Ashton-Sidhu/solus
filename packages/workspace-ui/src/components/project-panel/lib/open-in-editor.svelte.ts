import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { DetectedEditor, EditorId } from '@solus/contracts/types'
import { hostPolicy } from '@solus/client-core/host-policy'
import { localApi } from '@solus/client-core/local-api'
import { codebasesStore, getSessionEnvironmentStore, getWorkspaceContext, hosts } from '../../../contexts'
import { codebaseOf, runHost } from '../../../contexts/workspace/run-location'
import { requestInputFocus } from '../../../lib/inputFocus'
import { hasSessionStarted } from '../../../lib/sessionUtils'
import { toasts } from '../../../lib/toasts'
import { REMOTE_EDITOR_IDS, remoteEditorLink } from '../../../lib/remote-editor-link'
import { codebaseMembersOn } from './git-repositories'
import { editorFolders, editorFoldersTooltip, openInTarget, type OpenInTarget } from './open-in'

const REMOTE_EDITORS = REMOTE_EDITOR_IDS.map((id): DetectedEditor => ({
  id,
  name: id === 'vscode' ? 'VS Code' : id === 'zed' ? 'Zed' : 'Cursor',
  isTerminal: false,
  binPath: null,
}))

/**
 * The editor of one run: the apps that can open its folders, the one the
 * person chose, and the folders that it opens. The choice is the code editor
 * of Settings: the "Open in" row, its menu, and the folders menu of the
 * Environment card read and change that one setting. Construct it in
 * a component: it reads the workspace context.
 */
export class OpenInEditor {
  readonly #workspace = getWorkspaceContext()
  readonly #environments = getSessionEnvironmentStore()

  constructor(private readonly input: { readonly sourceId: string; readonly active: boolean }) {}

  readonly #run = $derived.by(() => this.#workspace.runFor(this.input.sourceId))
  readonly host = $derived(hosts.get(runHost(this.#run)))
  readonly #environment = $derived(this.#environments.environmentFor(this.#run))
  readonly isLocal = $derived(hostPolicy.isClientMachine(this.host?.id))
  readonly #sshTarget = $derived.by(() => {
    const info = this.host?.serverInfo
    return info?.state === 'ready' ? info.value.sshTarget : undefined
  })
  /** A local host opens apps through the desktop app; a remote host opens through an SSH link. */
  readonly canOpen = $derived(this.isLocal ? !!hosts.device?.hasDesktopHandlers : !!this.#sshTarget)
  readonly tools = $derived.by(() => (this.input.active && this.isLocal && this.canOpen ? this.host?.tools : undefined))
  readonly editors = $derived(this.isLocal ? (this.tools?.state === 'ready' ? this.tools.value.editors : []) : REMOTE_EDITORS)
  readonly target: OpenInTarget = $derived(
    this.isLocal
      ? openInTarget(this.#workspace.settings.defaultEditor, this.editors)
      : (REMOTE_EDITOR_IDS.find((id) => id === this.#workspace.settings.defaultEditor) ?? 'vscode'),
  )
  readonly editor = $derived(this.editors.find((item) => item.id === this.target))
  readonly isLoading = $derived(this.tools?.state === 'loading')
  readonly workingFolder = $derived(this.#environment.checkout?.worktreePath || this.#environment.cwd)
  readonly hasFolder = $derived(!!this.workingFolder && this.workingFolder !== NEW_CHAT_DIRECTORY)

  /** The other folders of the run on its host: the granted session folders, or the members of the codebase of a draft. */
  readonly #otherFolders = $derived.by((): string[] => {
    const session = this.#workspace.sessionFor(this.input.sourceId)
    if (session && hasSessionStarted(session)) {
      return (session.sessionFolders ?? []).filter((folder) => folder.granted).map((folder) => folder.path)
    }
    const codebaseId = codebaseOf(this.#run)
    const serverId = this.host?.id
    if (!codebaseId || !serverId) return []
    return codebaseMembersOn(codebasesStore.membersOf(codebaseId), serverId)
      .filter((member) => member.state !== 'missing')
      .map((member) => member.path)
  })

  /** The folders that the main action gives the chosen editor. */
  readonly folders = $derived(
    this.target === 'terminal' || !this.hasFolder
      ? { paths: [this.workingFolder], leftOut: 0 }
      : editorFolders({ workingFolder: this.workingFolder, otherFolders: this.#otherFolders, editorId: this.target, isRemote: !this.isLocal }),
  )
  readonly foldersTooltip = $derived(
    this.target === 'terminal' ? undefined : editorFoldersTooltip(this.folders, { editorName: this.editor?.name ?? this.target, isRemote: !this.isLocal }),
  )

  /** Whether this person may open the app on the host. */
  mayOpen(target: OpenInTarget): boolean {
    const isTerminal = target === 'terminal' || this.editors.find((item) => item.id === target)?.isTerminal
    return this.host?.me.may(this.isLocal ? (isTerminal ? 'host.terminal' : 'host.local.window') : 'host.files.read') ?? false
  }

  /** The row's menu changes the code editor of Settings. Terminal is no code editor. */
  choose(target: OpenInTarget): void {
    this.#workspace.settings.setDevice('defaultEditor', target === 'terminal' ? null : target)
  }

  /** Opens the folders in the editor. A remote host opens the first one through its SSH link. */
  async open(editorId: EditorId, paths: readonly string[]): Promise<void> {
    if (!this.canOpen || paths.length === 0) return
    if (!this.isLocal) {
      const link = this.#sshTarget ? remoteEditorLink(editorId, this.#sshTarget, paths[0]) : null
      if (link) void localApi.openExternal(link)
      requestInputFocus()
      return
    }
    const { sourceId } = this.input
    const environment = this.#environment
    const ctx = this.#workspace.ctxForEnvironment(environment.cwd, environment.checkout, sourceId)
    try {
      const opened = await this.#workspace.apiFor(sourceId).openInEditor(ctx, {
        editorId,
        filePaths: [...paths],
        cwd: paths[0],
        fallbackTerminalId: this.#workspace.settings.fallbackTerminal ?? undefined,
      })
      if (!opened) toasts.error(`Could not open ${this.editors.find((item) => item.id === editorId)?.name ?? editorId}`)
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : 'Could not open the editor')
    }
    requestInputFocus()
  }
}
