import { existingTaskId, taskBindingSessionId } from './session-draft.svelte'
import type { Attachment, Prompt, PromptImageRef, PromptOptions, Session, SessionMetadataGenerationContext } from '@solus/contracts/types'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { WorksStore } from '../works/works.store.svelte'
import type { TasksStore } from '../tasks/tasks.store.svelte'

/** How one turn's images are split between the two ways they can travel. */
export interface PromptImagePayload {
  /** Images the run host already stores; it re-reads its own file. */
  refs: PromptImageRef[]
  /** Images the host has never received, sent as bytes. */
  inline: NonNullable<PromptOptions['imageAttachments']>
}

export class PromptComposer {
  constructor(
    private planStore: PlanStore,
    private worksStore: WorksStore,
    private tasksStore: TasksStore,
  ) {}

  compose(prompt: string, input: Prompt, session: Session): string {
    let fullPrompt = prompt
    if (input.planRefs.length > 0) {
      const planCtx = input.planRefs.map((ref) => {
        const plan = this.planStore.get(ref.planId)
        if (plan?.filePath) {
          return `[Referenced Plan: ${ref.title}]\nFile path: ${plan.filePath}`
        }
        return `[Referenced Plan: ${ref.title}]\n${plan?.content || '(Plan content unavailable)'}`
      }).join('\n\n')
      fullPrompt = fullPrompt ? `${fullPrompt}\n\n${planCtx}` : planCtx
    }
    if (input.workRefs.length > 0) {
      const workCtx = input.workRefs.map((ref) => {
        const work = this.worksStore.get(ref.workId)
        const parts = [`[Referenced Work: ${ref.title}]`, `Type: ${work?.type ?? ref.type}`]
        parts.push(`File path: ${workFilePath(work?.id ?? ref.workId, work?.storage)}`)
        return parts.join('\n')
      }).join('\n\n')
      fullPrompt = fullPrompt ? `${fullPrompt}\n\n${workCtx}` : workCtx
    }
    if (input.sessionRefs.length > 0) {
      // Reference each session by id — the agent reads the transcript on demand
      // via read_session rather than us inlining it. Provider-agnostic: both
      // Claude and Codex export read_session, so the text is identical.
      const sessionCtx = input.sessionRefs.map((ref) =>
        [
          `[Referenced Session: "${ref.title}" (session_id: ${ref.sessionId}, provider: ${ref.provider})]`,
          `Call read_session with session_id "${ref.sessionId}" to read its transcript before responding.`,
        ].join('\n')).join('\n\n')
      fullPrompt = fullPrompt ? `${fullPrompt}\n\n${sessionCtx}` : sessionCtx
    }
    if (session.boundWorkId) {
      const boundWork = this.worksStore.get(session.boundWorkId)
      if (!boundWork) {
        session.boundWorkId = null
      } else {
        // Reference the work by id rather than inlining its body — the agent reads
        // the latest content on demand via read_work (which returns the clean body,
        // not the on-disk JSON envelope) and revises it through update_work.
        const boundBlock = [
          `[Working On - "${boundWork.title}" (work_id: ${boundWork.id})]`,
          `Call read_work with work_id "${boundWork.id}" to read the current content. To revise it, call update_work with the same work_id - do not emit a new fence.`,
        ].join('\n')
        fullPrompt = fullPrompt ? `${fullPrompt}\n\n${boundBlock}` : boundBlock
      }
    }
    // The durable link outranks the binding recorded at first dispatch: the
    // agent can move a session to another task, and the header must follow.
    const taskId = this.tasksStore.taskForSession(taskBindingSessionId(session))?.id
      ?? existingTaskId(session.task)
    if (taskId) {
      // The full ticket (body + comments + linked PRs) is hydrated into the run's
      // system prompt server-side, which a remote host can only do for a task it
      // owns. Naming the binding in the prompt keeps the thread readable there and
      // tells the agent where to re-fetch live state — mirrors the bound-work block.
      const boundTask = this.tasksStore.tasks.find((task) => task.id === taskId)
      const title = boundTask ? ` "${boundTask.title}"` : ''
      const taskBlock = [
        `[Working On Task${title} (task_id: ${taskId})]`,
        `Call read_task with task_id "${taskId}" to read the latest status, comments, and linked PRs; call update_task_status to move it. Do not mark tasks as done unless explicitly told to.`,
      ].join('\n')
      fullPrompt = fullPrompt ? `${fullPrompt}\n\n${taskBlock}` : taskBlock
    }
    // Images are sent to the agent as real content blocks (see imageAttachments
    // in PromptComposer.composeImages), so they're excluded from the text prompt.
    // Files and design selections remain text references — they carry metadata, not raw payloads.
    const textAttachments = input.attachments.filter((a) => a.type !== 'image')
    if (textAttachments.length > 0) {
      const attachmentCtx = composeAttachmentContext(textAttachments, session.run.serverId)
      fullPrompt = `${attachmentCtx}\n\n${fullPrompt}`
    }
    return fullPrompt
  }

  /** Image attachments to send as real content blocks. Only images with a
   *  base64 `dataUrl` qualify; everything else stays a text reference. */
  composeImages(input: Prompt): Array<{ mimeType: string; dataUrl: string }> {
    return input.attachments
      .filter((a) => a.type === 'image' && !!a.dataUrl)
      .map((a) => ({ mimeType: a.mimeType ?? 'image/png', dataUrl: a.dataUrl! }))
  }

  /**
   * How this turn's images travel. An image the run host already stores goes as
   * a ref — the host re-reads its own file — so the bytes stay in the composer
   * instead of crossing the transport on every send. An image the host never
   * received (an older host with no `attachUpload`, or a failed upload) still
   * goes inline, and a host that cannot resolve refs takes everything inline.
   */
  composeImagePayload(
    input: Pick<Prompt, 'attachments'>,
    serverId: string,
    hostResolvesRefs: boolean,
  ): PromptImagePayload {
    const refs: PromptImagePayload['refs'] = []
    const inline: PromptImagePayload['inline'] = []
    for (const attachment of input.attachments) {
      if (attachment.type !== 'image') continue
      const mimeType = attachment.mimeType ?? 'image/png'
      const storedByRunHost = !!attachment.hostPath
        && (!attachment.hostServerId || attachment.hostServerId === serverId)
      if (hostResolvesRefs && storedByRunHost) {
        refs.push({ mimeType, hostPath: attachment.hostPath!, name: attachment.name })
      } else if (attachment.dataUrl) {
        inline.push({ mimeType, dataUrl: attachment.dataUrl })
      }
    }
    return { refs, inline }
  }

  /** Session naming gets the real image through the same remote-safe transport
   * as the turn plus only safe display metadata. */
  composeSessionMetadataContext(
    attachments: Attachment[],
    serverId: string,
    hostResolvesRefs: boolean,
  ): SessionMetadataGenerationContext | undefined {
    if (attachments.length === 0) return undefined
    const imagePayload = this.composeImagePayload({ attachments }, serverId, hostResolvesRefs)
    const context: SessionMetadataGenerationContext = {
      attachments: attachments.slice(0, 8).map((attachment) => ({
        name: attachment.name,
        type: attachment.type,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    }
    if (imagePayload.refs.length > 0) context.imageAttachmentRefs = imagePayload.refs
    if (imagePayload.inline.length > 0) context.imageAttachments = imagePayload.inline
    return context
  }
}

/** The agent can use only a path owned by its host. A missing/stale remote
 *  upload degrades to the display name instead of leaking a client path. */
export function attachmentPromptPath(attachment: Attachment, serverId: string): string {
  if (serverId === LOCAL_SERVER_ID) return attachment.path
  if (
    attachment.hostPath &&
    (!attachment.hostServerId || attachment.hostServerId === serverId)
  ) {
    return attachment.hostPath
  }
  return attachment.name
}

export function composeAttachmentContext(attachments: Attachment[], serverId: string): string {
  return attachments.map((attachment) => {
    const path = attachmentPromptPath(attachment, serverId)
    if (attachment.type === 'design-selection' && attachment.designData) {
      const data = attachment.designData
      if (data.annotationContext) {
        const parts = [`[Browser annotation: ${attachment.name}]`]
        if (attachment.hostPath) parts.push(`Annotated capture: ${attachment.hostPath}`)
        parts.push(data.annotationContext)
        return parts.join('\n')
      }
      const parts = [`[Design Mode Selection: ${path}]`]
      if (data.outerHTML) parts.push(`Element: ${data.outerHTML.slice(0, 2000)}`)
      if (data.cssSelector) parts.push(`Selector: ${data.cssSelector}`)
      if (data.computedStyles) parts.push(`Styles: ${JSON.stringify(data.computedStyles)}`)
      if (data.componentName) parts.push(`Component: ${data.componentName}${data.componentFile ? ` (${data.componentFile})` : ''}`)
      if (data.pageURL) parts.push(`Page: ${data.pageURL}`)
      if (data.annotations?.length) {
        parts.push(`Annotations: ${data.annotations.map((annotation, index) => `[${annotation.label ?? index + 1}] ${annotation.type}`).join(', ')}`)
      }
      return parts.join('\n')
    }
    return `[Attached ${attachment.type}: ${path}]`
  }).join('\n')
}

function workFilePath(workId: string, storage: { kind: 'local' } | { kind: 'project'; projectRoot?: string; relativePath: string } | undefined): string {
  const fileName = `${workId}.json`
  if (storage?.kind === 'project') {
    const base = storage.projectRoot
      ? `${storage.projectRoot}/${storage.relativePath}`
      : storage.relativePath
    return `${base}/${fileName}`
  }
  return `~/.solus/works/${fileName}`
}
