import type { AgentId, IpcContext } from '@solus/contracts/types'
import { createAppContext } from './create-app-context'

/** The session a client shell can carry into another native window. */
export interface ClientSessionRef {
  sessionId: string
  serverId: string
  provider: AgentId
  cwd: string
  title: string | null
}

/** Client-owned facts. Shared features do not select a layout or read native events. */
export interface ClientShellContext {
  readonly visible: boolean
  readonly workAreaWidth: number
  readonly workAreaHeight: number
  readonly hasInsetTitlebar: boolean
  readonly supportsLocalAttachments: boolean
  readonly supportsNativeSettings: boolean
  readonly isOverlayWindow: boolean
  readonly hasProjectPanel: boolean
  readonly hasCompanionPanes: boolean
  readonly groupsTabsByBranch: boolean
  readonly conversationVisible: boolean
  readonly deferHistoryToolInputs: boolean
  /** Compatibility at the RPC boundary only; never used to choose shared UI. */
  readonly rpcWindow: IpcContext['window']
  showWorkspace?(): Promise<void>
  continueInOtherWindow?(session?: ClientSessionRef): Promise<void>
}

export const [getClientShellContext, setClientShellContext] =
  createAppContext<ClientShellContext>('client-shell')
