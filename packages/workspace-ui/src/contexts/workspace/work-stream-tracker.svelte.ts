import type { AgentId, Message, NormalizedEvent, Session } from '@solus/contracts/types'
import { nextMsgId } from './session.utils'
import type { RouterStore } from './routing/router.store.svelte'
import type { WorksStore } from '../works/works.store.svelte'
import { runtime } from '../app/runtime.svelte'
import { artifactHasBody, isPreviewArtifactCall, partialArtifactHtml } from './streaming-artifact'
import { checkoutPlace, runHost } from './run-location'

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

  beginWorkStream(session: Session, toolName: string | undefined, agentProvider: AgentId): void {
    if (!isCreateWorkTool(toolName)) return
    const tempId = this.worksStore.addProvisional(agentProvider, checkoutPlace(session.run).path, runHost(session.run))
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
  }

  /** The artifact card a work update renders in, or undefined when the work is not an artifact. */
  private artifactWorkRef(session: Session, workId: string): Message['workRef'] {
    const previous = session.messages.findLast((message) => message.workRef?.workId === workId && message.artifact)
    const work = this.worksStore.get(workId)
    if (!previous && work?.type !== 'artifact') return undefined
    return { workId, title: previous?.workRef?.title ?? work?.title ?? '', workType: 'artifact' }
  }

  /**
   * Show a `render_artifact` or artifact `update_work` call as it is written.
   * No card exists before the input has a body to render: a call shows only its
   * tool row until then. Off on a touch client, where re-creating an iframe
   * every few hundred milliseconds costs more than the wait it saves.
   */
  updateStreamingArtifact(session: Session, toolName: string | undefined, toolInput: string, toolId?: string): void {
    if (!toolId) return
    const isUpdate = !!toolName?.endsWith('update_work')
    if (!isRenderArtifactTool(toolName) && !isUpdate) return
    // The html can stream before the preview flag. A preview renders nothing in
    // the conversation, so its card goes as soon as the input says so.
    if (!isUpdate && isPreviewArtifactCall(toolInput)) return this.failArtifact(session, toolId)
    if (runtime.isTouchDevice) return
    const now = Date.now()
    const last = this.lastProgressiveTickByTool.get(`${session.id}:${toolId}`) ?? 0
    if (now - last < PROGRESSIVE_RENDER_MS) return

    const html = partialArtifactHtml(toolInput, isUpdate ? 'content' : 'html')
    if (!html || !artifactHasBody(html)) return
    const card = session.messages.find((m) => m.artifact?.toolId === toolId)
    // A completed card is the last word; a late input tick cannot reopen it.
    if (card && !card.artifact?.streaming) return

    this.lastProgressiveTickByTool.set(`${session.id}:${toolId}`, now)
    if (card?.artifact) {
      // Mutated in place, never replaced: a new message object would invalidate
      // every derived read of the transcript on each tick.
      card.artifact.html = html
      return
    }
    const workId = isUpdate ? /"work_id"\s*:\s*"([^"\\]+)"/.exec(toolInput)?.[1] : undefined
    const workRef = workId ? this.artifactWorkRef(session, workId) : undefined
    if (isUpdate && !workRef) return
    session.messages.push({
      id: nextMsgId(), role: 'assistant', content: '', timestamp: Date.now(),
      artifact: { kind: 'html', html, streaming: true, toolId },
      ...(workRef ? { workRef } : {}),
    })
  }

  finalizeWork(session: Session, event: WorkCreatedEvent): void {
    const entries = this.workStreamsBySession.get(session.id)
    const stream = entries?.find((e) => !e.finalized)
    if (stream) {
      stream.finalized = true
      this.worksStore.finalizeProvisional(stream.tempId, event.workId, event.title, event.docType, event.content, runHost(session.run))
      // If the user opened the provisional card mid-stream, follow the rekey so
      // the open pane points at the persisted id, not the deleted temp one.
      if (this.router.params('work')?.workId === stream.tempId) {
        this.router.navigate(
          { name: 'work', params: { workId: event.workId, serverId: runHost(session.run) } },
          { replace: true },
        )
      }
      const msg = session.messages.find((m) => m.id === stream.msgId)
      if (msg?.workRef) {
        msg.workRef.workId = event.workId
        msg.workRef.title = event.title
        msg.workRef.workType = event.docType
        msg.workRef.contentVersion = 1
      }
    } else {
      // No streamed provisional (Codex/mock emit work_created directly).
      this.worksStore.finalizeProvisional(null, event.workId, event.title, event.docType, event.content, runHost(session.run))
      session.messages.push({
        id: nextMsgId(),
        role: 'assistant' as const,
        content: '',
        workRef: { workId: event.workId, title: event.title, workType: event.docType, contentVersion: 1 },
        timestamp: Date.now(),
      })
    }
  }

  finalizeArtifact(session: Session, event: ArtifactCreatedEvent): void {
    // An HTML artifact was persisted as an `artifact` work: place it in the
    // store so the gallery, task links, and the pane can open it by id.
    const workRef = event.workId
      ? { workId: event.workId, title: event.title ?? '', workType: 'artifact' as const, contentVersion: 1 }
      : undefined
    if (workRef && event.html !== undefined) {
      this.worksStore.finalizeProvisional(null, workRef.workId, workRef.title, 'artifact', event.html, runHost(session.run))
    }

    this.completeArtifactPreview(session, event, workRef)
  }

  private completeArtifactPreview(session: Session, event: ArtifactCreatedEvent, workRef: Message['workRef']): Message {
    // Match only the originating call. Older hosts without a tool id append a
    // completed card; their unmatched streaming cards are removed at turn end.
    // The persisted document is the last word: a progressive render stops the
    // moment this lands, so what stays on screen is the work, not a tick of it.
    this.lastProgressiveTickByTool.delete(`${session.id}:${event.toolId}`)
    const streaming = event.toolId ? session.messages.find((m) =>
      m.artifact && m.artifact.toolId === event.toolId && m.artifact.streaming,
    ) : undefined
    if (streaming?.artifact) {
      streaming.artifact.kind = event.kind
      streaming.artifact.html = event.html
      streaming.artifact.path = event.path
      streaming.artifact.streaming = false
      if (workRef) streaming.workRef = workRef
      return streaming
    }

    const completed: Message = {
      id: nextMsgId(),
      role: 'assistant' as const,
      content: '',
      artifact: { kind: event.kind, html: event.html, path: event.path },
      workRef,
      timestamp: Date.now(),
    }
    session.messages.push(completed)
    return completed
  }

  failArtifact(session: Session, toolId: string): void {
    this.lastProgressiveTickByTool.delete(`${session.id}:${toolId}`)
    const index = session.messages.findIndex((message) =>
      message.artifact?.toolId === toolId && message.artifact.streaming,
    )
    if (index !== -1) session.messages.splice(index, 1)
  }

  updateWork(session: Session, event: Extract<NormalizedEvent, { type: 'work_updated' }>): void {
    // An update never changes a work's type, and a cloud-owned save cannot read
    // the row it updates: it reports `doc` and no title. The saved record or
    // an artifact card of the work in this conversation is the authority.
    const saved = this.worksStore.get(event.workId)
    const artifactRef = this.artifactWorkRef(session, event.workId)
    const title = event.title || saved?.title || artifactRef?.title || ''
    const isStale = session.messages.some((message) => message.workRef?.workId === event.workId
      && message.artifact?.updatedAt && message.artifact.updatedAt >= event.updatedAt)
    if (isStale) {
      if (event.toolId) this.failArtifact(session, event.toolId)
      return
    }
    if (event.docType !== 'artifact' && !artifactRef) {
      session.messages.push({
        id: nextMsgId(), role: 'assistant', content: '',
        workRef: { workId: event.workId, title, workType: saved?.type ?? event.docType, contentVersion: event.contentVersion },
        timestamp: Date.now(),
      })
      return
    }
    // The reducer applies the authoritative update to WorksStore. Completing
    // the inline preview must not replace that record or its saved metadata.
    const completed = this.completeArtifactPreview(session, {
      type: 'artifact_created', kind: 'html', html: event.content,
      workId: event.workId, title, toolId: event.toolId,
    }, { workId: event.workId, title, workType: 'artifact', contentVersion: event.contentVersion })
    if (completed.artifact) completed.artifact.updatedAt = event.updatedAt
  }

  /** Drop provisional cards whose create_work never persisted (tool errored, or
   *  the turn ended), plus any artifact cards still streaming when the call
   *  failed or the turn ended. Finalized streams keep their card; only the tracking is cleared. */
  sweep(session: Session): void {
    for (const key of this.lastProgressiveTickByTool.keys()) {
      if (key.startsWith(`${session.id}:`)) this.lastProgressiveTickByTool.delete(key)
    }
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const artifact = session.messages[i].artifact
      if (artifact?.streaming) session.messages.splice(i, 1)
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
