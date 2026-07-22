import type { AgentId, NormalizedEvent, Session } from '../../../shared/types'
import { uuid } from '../../../shared/uuid'
import { nextMsgId } from './session.utils'
import type { PaneViewStore } from './pane-view.store.svelte'
import type { WorksStore } from '../works/works.store.svelte'

/** An in-flight create_work tool call backing a provisional skeleton card. */
interface WorkStreamEntry {
  /** Provisional store id the skeleton renders from until work_created rekeys it. */
  tempId: string
  /** Id of the pushed workRef message, so finalize/sweep can find it. */
  msgId: string
  finalized: boolean
}

type WorkCreatedEvent = Extract<NormalizedEvent, { type: 'work_created' }>
type ArtifactCreatedEvent = Extract<NormalizedEvent, { type: 'artifact_created' }>

/** Matches both Claude (`mcp__solus__create_work`) and Codex (`create_work`). */
function isCreateWorkTool(name: string | undefined): boolean {
  return !!name && name.endsWith('create_work')
}

/** Matches both Claude (`mcp__solus__render_artifact`) and Codex (`render_artifact`). */
function isRenderArtifactTool(name: string | undefined): boolean {
  return !!name && name.endsWith('render_artifact')
}

export class WorkStreamTracker {
  /** In-flight create_work streams per tab. Correlates streamed tool input to
   *  provisional store work; work_created reconciles them positionally. */
  private workStreamsByTab = new Map<string, WorkStreamEntry[]>()

  constructor(
    private worksStore: WorksStore,
    private panes: PaneViewStore,
  ) {}

  beginToolArtifacts(tabId: string, session: Session, toolName: string | undefined, agentProvider: AgentId): void {
    if (isCreateWorkTool(toolName)) {
      const tempId = uuid()
      this.worksStore.addProvisional(tempId, agentProvider, session.workingDirectory)
      const msgId = nextMsgId()
      session.messages.push({
        id: msgId,
        role: 'assistant',
        content: '',
        workRef: { workId: tempId, title: 'Untitled', workType: 'doc' },
        timestamp: Date.now(),
      })
      const entries = this.workStreamsByTab.get(tabId) ?? []
      entries.push({ tempId, msgId, finalized: false })
      this.workStreamsByTab.set(tabId, entries)
      return
    }

    if (isRenderArtifactTool(toolName)) {
      session.messages.push({
        id: nextMsgId(),
        role: 'assistant',
        content: '',
        artifact: { kind: 'html', pending: true },
        timestamp: Date.now(),
      })
    }
  }

  finalizeWork(tabId: string, session: Session, event: WorkCreatedEvent): void {
    const entries = this.workStreamsByTab.get(tabId)
    const stream = entries?.find((e) => !e.finalized)
    if (stream) {
      stream.finalized = true
      this.worksStore.finalizeProvisional(stream.tempId, event.workId, event.title, event.docType, event.content)
      // If the user opened the provisional card mid-stream, follow the rekey
      // so the open pane points at the persisted id, not the deleted temp one.
      this.panes.rekeyWork(stream.tempId, event.workId)
      const msg = session.messages.find((m) => m.id === stream.msgId)
      if (msg?.workRef) {
        msg.workRef.workId = event.workId
        msg.workRef.title = event.title
        msg.workRef.workType = event.docType
      }
    } else {
      // No streamed provisional (Codex/mock emit work_created directly).
      this.worksStore.finalizeProvisional('', event.workId, event.title, event.docType, event.content)
      session.messages.push({
        id: nextMsgId(),
        role: 'assistant' as const,
        content: '',
        workRef: { workId: event.workId, title: event.title, workType: event.docType },
        timestamp: Date.now(),
      })
    }
  }

  finalizeArtifact(session: Session, event: ArtifactCreatedEvent): void {
    // Fill the oldest pending render_artifact skeleton (positional
    // correlation: the executor can't see the model-side tool id). No
    // provisional (Codex/mock emit directly) means pushing a fresh message.
    const pending = session.messages.find((m) => m.artifact?.pending)
    if (pending?.artifact) {
      pending.artifact.kind = event.kind
      pending.artifact.html = event.html
      pending.artifact.path = event.path
      pending.artifact.pending = false
      return
    }

    session.messages.push({
      id: nextMsgId(),
      role: 'assistant' as const,
      content: '',
      artifact: { kind: event.kind, html: event.html, path: event.path },
      timestamp: Date.now(),
    })
  }

  /** Drop provisional cards whose create_work never persisted (tool errored, or
   *  the turn ended), plus any render_artifact skeletons left pending by a failed
   *  call. Finalized streams keep their card; only the tracking is cleared. */
  sweep(tabId: string, session: Session | null): void {
    if (session) {
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].artifact?.pending) session.messages.splice(i, 1)
      }
    }
    const entries = this.workStreamsByTab.get(tabId)
    if (!entries) return
    for (const entry of entries) {
      if (entry.finalized) continue
      this.worksStore.removeProvisional(entry.tempId)
      if (session) {
        const idx = session.messages.findIndex((m) => m.id === entry.msgId)
        if (idx !== -1) session.messages.splice(idx, 1)
      }
    }
    this.workStreamsByTab.delete(tabId)
  }
}
