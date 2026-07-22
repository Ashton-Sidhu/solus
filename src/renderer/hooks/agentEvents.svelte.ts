import { onDestroy } from 'svelte'
import type { WorkspaceContext } from '../contexts'
import type { NormalizedEvent, SkillStatus } from '../../shared/types'
import { resyncRuntime } from '../contexts/workspace/session-bootstrap'

/**
 * Bridges ControlPlane IPC events into the session context. Call from App.svelte's top-level script,
 * not inside $effect — the unsubscribes are tied to the component's lifetime.
 *
 * `text_chunk` volume is already tamed upstream: ControlPlane coalesces chunks into
 * ~300ms batches before broadcasting, so no renderer-side batching is needed here.
 */
export function setupAgentEvents(session: WorkspaceContext): void {
  const unsubEvent = window.solus.onEvent((tabId: string, event: NormalizedEvent) => {
    session.handleNormalizedEvent(tabId, event)
  })

  const unsubError = window.solus.onError((tabId: string, error: any) => {
    session.handleError(tabId, error)
  })

  const unsubSkill = window.solus.onSkillStatus((status: SkillStatus) => {
    if (status.state === 'failed') {
      console.warn(`[SOLUS] Skill install failed: ${status.name} — ${status.error}`)
    }
  })

  // When the WS transport receives an explicit seq-reset, re-register tabs and re-bind sessions.
  // Re-register tabs and re-bind sessions without wiping client state.
  const solusApi = window.solus as any
  const unsubReset = solusApi.onResetRuntime?.(() => {
    void resyncRuntime(session)
  })

  onDestroy(() => {
    unsubEvent()
    unsubError()
    unsubSkill()
    unsubReset?.()
  })
}
