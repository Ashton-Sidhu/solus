import { createAppContext } from './create-app-context'

/** Client-owned facts. Shared features do not select a layout or read native events. */
export interface ClientShellContext {
  readonly visible: boolean
  readonly workAreaWidth: number
  readonly workAreaHeight: number
  readonly hasInsetTitlebar: boolean
  readonly supportsLocalAttachments: boolean
  readonly supportsNativeSettings: boolean
  readonly hasProjectPanel: boolean
  readonly hasCompanionPanes: boolean
  readonly deferHistoryToolInputs: boolean
  /** The workspace surrounds this surface: the Workspace page, chats, publishing,
   *  sharing. The guest shell (docs/plans/multiplayer-sharing.md §4.2) has none of
   *  it, so a surface offers no way there. */
  readonly hasWorkspace: boolean
}

export const [getClientShellContext, setClientShellContext] =
  createAppContext<ClientShellContext>('client-shell')
