import type { AgentId, NormalizedEvent, Session } from '@solus/contracts/types'
import { nextMsgId } from './session.utils'
import type { RouterStore } from './routing/router.store.svelte'
import type { WorksStore } from '../works/works.store.svelte'
import { runtime } from '../app/runtime.svelte'
import { artifactHasBody, partialArtifactHtml } from './streaming-artifact'

/** A floor, not a target: a slower host may raise it. Each tick re-creates the
 *  iframe, so the reader watches the render arrive in steps rather than
 *  watching a document repaint at the rate the model writes. */
const PROGRESSIVE_RENDER_MS = 400

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
  /** In-flight create_work streams per session. Correlates streamed tool input
   *  to provisional store work; work_created reconciles them positionally.
   *  Keyed by the conversation that is streaming, not by a tab watching it —
   *  two views of one session share the one in-flight card. */
  private workStreamsBySession = new Map<string, WorkStreamEntry[]>()
  /** When each tool call last let a streaming render through. Throttled here
   *  rather than in the view: one clock per tool call, and the transcript
   *  never sees an update it has to discard. */
  private lastProgressiveTickByTool = new Map<string, number>()

  constructor(
    private worksStore: WorksStore,
    private router: RouterStore,
  ) {}

  beginToolArtifacts(session: Session, toolName: string | undefined, agentProvider: AgentId, toolId?: string): void {
    if (isCreateWorkTool(toolName)) {
      const tempId = this.worksStore.addProvisional(agentProvider, session.run.workingDirectory, session.run.serverId)
      const msgId = nextMsgId()
      session.messages.push({
        id: msgId,
        role: 'assistant',
        content: '',
        workRef: { workId: tempId, title: 'Untitled', workType: 'doc' },
        timestamp: Date.now(),
      })
      const entries = this.workStreamsBySession.get(session.id) ?? []
      entries.push({ tempId, msgId, finalized: false })
      this.workStreamsBySession.set(session.id, entries)
      return
    }

    if (isRenderArtifactTool(toolName)) {
      session.messages.push({
        id: nextMsgId(),
        role: 'assistant',
        content: '',
        artifact: { kind: 'html', pending: true, toolId },
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Show a `render_artifact` call as it is written, instead of a skeleton until
   * it finishes. Off on a touch client, where re-creating an iframe every few
   * hundred milliseconds costs more than the wait it saves.
   */
  updateStreamingArtifact(session: Session, toolName: string | undefined, toolInput: string, toolId?: string): void {
    if (!isRenderArtifactTool(toolName) || !toolId || runtime.isTouchDevice) return
    const now = Date.now()
    const last = this.lastProgressiveTickByTool.get(`${session.id}:${toolId}`) ?? 0
    if (now - last < PROGRESSIVE_RENDER_MS) return

    const html = partialArtifactHtml(toolInput)
    if (!html || !artifactHasBody(html)) return
    const pending = session.messages.find((m) => m.artifact?.toolId === toolId && (m.artifact.pending || m.artifact.streaming))
    if (!pending?.artifact) return

    this.lastProgressiveTickByTool.set(`${session.id}:${toolId}`, now)
    // Mutated in place, never replaced: a new message object would invalidate
    // every derived read of the transcript on each tick.
    pending.artifact.html = html
    pending.artifact.pending = false
    pending.artifact.streaming = true
  }

  finalizeWork(session: Session, event: WorkCreatedEvent): void {
    const entries = this.workStreamsBySession.get(session.id)
    const stream = entries?.find((e) => !e.finalized)
    if (stream) {
      stream.finalized = true
      this.worksStore.finalizeProvisional(stream.tempId, event.workId, event.title, event.docType, event.content, session.run.serverId)
      // If the user opened the provisional card mid-stream, follow the rekey so
      // the open pane points at the persisted id, not the deleted temp one.
      if (this.router.params('work')?.workId === stream.tempId) {
        this.router.navigate(
          { name: 'work', params: { workId: event.workId, serverId: session.run.serverId } },
          { replace: true },
        )
      }
      const msg = session.messages.find((m) => m.id === stream.msgId)
      if (msg?.workRef) {
        msg.workRef.workId = event.workId
        msg.workRef.title = event.title
        msg.workRef.workType = event.docType
      }
    } else {
      // No streamed provisional (Codex/mock emit work_created directly).
      this.worksStore.finalizeProvisional(null, event.workId, event.title, event.docType, event.content, session.run.serverId)
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
    // An HTML artifact was persisted as an `artifact` work: place it in the
    // store so the gallery, task links, and the pane can open it by id.
    const workRef = event.workId
      ? { workId: event.workId, title: event.title ?? '', workType: 'artifact' as const }
      : undefined
    if (workRef && event.html !== undefined) {
      this.worksStore.finalizeProvisional(null, workRef.workId, workRef.title, 'artifact', event.html, session.run.serverId)
    }

    // Match only the originating call. Older hosts without a tool id append a
    // completed card; their unmatched provisional cards are removed at turn end.
    // The persisted document is the last word: a progressive render stops the
    // moment this lands, so what stays on screen is the work, not a tick of it.
    this.lastProgressiveTickByTool.delete(`${session.id}:${event.toolId}`)
    const pending = event.toolId ? session.messages.find((m) =>
      m.artifact && m.artifact.toolId === event.toolId && (m.artifact.pending || m.artifact.streaming),
    ) : undefined
    if (pending?.artifact) {
      pending.artifact.kind = event.kind
      pending.artifact.html = event.html
      pending.artifact.path = event.path
      pending.artifact.pending = false
      pending.artifact.streaming = false
      if (workRef) pending.workRef = workRef
      return
    }

    session.messages.push({
      id: nextMsgId(),
      role: 'assistant' as const,
      content: '',
      artifact: { kind: event.kind, html: event.html, path: event.path },
      workRef,
      timestamp: Date.now(),
    })
  }

  failArtifact(session: Session, toolId: string): void {
    this.lastProgressiveTickByTool.delete(`${session.id}:${toolId}`)
    const index = session.messages.findIndex((message) =>
      message.artifact?.toolId === toolId && (message.artifact.pending || message.artifact.streaming),
    )
    if (index !== -1) session.messages.splice(index, 1)
  }

  /** Drop provisional cards whose create_work never persisted (tool errored, or
   *  the turn ended), plus any render_artifact skeletons left pending by a failed
   *  call. Finalized streams keep their card; only the tracking is cleared. */
  sweep(session: Session): void {
    for (const key of this.lastProgressiveTickByTool.keys()) {
      if (key.startsWith(`${session.id}:`)) this.lastProgressiveTickByTool.delete(key)
    }
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const artifact = session.messages[i].artifact
      if (artifact?.pending || artifact?.streaming) session.messages.splice(i, 1)
    }
    const entries = this.workStreamsBySession.get(session.id)
    if (!entries) return
    for (const entry of entries) {
      if (entry.finalized) continue
      this.worksStore.removeProvisional(entry.tempId)
      const idx = session.messages.findIndex((m) => m.id === entry.msgId)
      if (idx !== -1) session.messages.splice(idx, 1)
    }
    this.workStreamsBySession.delete(session.id)
  }
}
