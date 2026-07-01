import { onDestroy } from 'svelte'
import type { WorkspaceContext } from '../contexts/workspace.context.svelte'
import type { NormalizedEvent, SkillStatus } from '../../shared/types'
import { resyncRuntime } from '../contexts/session-bootstrap'

/**
 * Bridges ControlPlane IPC events into the session context. Call from App.svelte's top-level script,
 * not inside $effect — the unsubscribes are tied to the component's lifetime.
 *
 * `text_chunk` events are coalesced per animation frame; a single run can emit hundreds per second
 * and one reactive write per chunk saturates the scheduler.
 */
export function setupAgentEvents(session: WorkspaceContext): void {
  const chunkBuffer = new Map<string, string>()
  let rafId = 0

  const flushChunks = () => {
    rafId = 0
    if (chunkBuffer.size === 0) return
    for (const [tabId, text] of chunkBuffer) {
      session.handleNormalizedEvent(tabId, { type: 'text_chunk', text } as NormalizedEvent)
    }
    chunkBuffer.clear()
  }

  const unsubEvent = window.solus.onEvent((tabId: string, event: NormalizedEvent) => {
    if (event.type === 'text_chunk') {
      const existing = chunkBuffer.get(tabId) || ''
      chunkBuffer.set(tabId, existing + (event as any).text)
      if (!rafId) {
        rafId = requestAnimationFrame(flushChunks)
      }
    } else {
      // Drain buffered chunks before boundary events so task_update/task_complete observe final text.
      if ((event.type === 'task_update' || event.type === 'task_complete') && rafId) {
        cancelAnimationFrame(rafId)
        flushChunks()
      }
      session.handleNormalizedEvent(tabId, event)
    }
  })

  const unsubError = window.solus.onError((tabId: string, error: any) => {
    session.handleError(tabId, error)
  })

  const unsubSkill = window.solus.onSkillStatus((status: SkillStatus) => {
    if (status.state === 'failed') {
      console.warn(`[SOLUS] Skill install failed: ${status.name} — ${status.error}`)
    }
  })

  // When the WS transport detects a gap and re-issues a seq-watermark, it signals a reset.
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
    if (rafId) cancelAnimationFrame(rafId)
    chunkBuffer.clear()
  })
}
