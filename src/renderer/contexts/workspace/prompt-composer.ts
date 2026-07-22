import type { InputState, Session } from '../../../shared/types'
import type { PlanStore } from '../plans/plan.store.svelte'
import type { WorksStore } from '../works/works.store.svelte'
import type { TasksStore } from '../tasks/tasks.store.svelte'

export class PromptComposer {
  constructor(
    private planStore: PlanStore,
    private worksStore: WorksStore,
    private tasksStore: TasksStore,
  ) {}

  compose(prompt: string, input: InputState, session: Session): string {
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
    if (session.boundTaskId) {
      // The full ticket (body + comments + linked PRs) is hydrated and injected
      // server-side on the *first* prompt only. Re-affirm the binding by reference
      // on every follow-up so the agent doesn't lose the thread mid-session and
      // can re-fetch the live state via get_task — mirrors the bound-work block.
      const boundTask = this.tasksStore.tasks.find((t) => t.id === session.boundTaskId)
      const title = boundTask ? ` "${boundTask.title}"` : ''
      const taskBlock = [
        `[Working On Task${title} (task_id: ${session.boundTaskId})]`,
        `Call get_task with task_id "${session.boundTaskId}" to read the latest status, comments, and linked PRs; call update_task_status to move it.`,
      ].join('\n')
      fullPrompt = fullPrompt ? `${fullPrompt}\n\n${taskBlock}` : taskBlock
    }
    // Images are sent to the agent as real content blocks (see imageAttachments
    // in PromptComposer.composeImages), so they're excluded from the text prompt.
    // Files and design selections remain text references — they carry metadata, not raw payloads.
    const textAttachments = input.attachments.filter((a) => a.type !== 'image')
    if (textAttachments.length > 0) {
      const attachmentCtx = textAttachments.map((a) => {
        if (a.type === 'design-selection' && a.designData) {
          const d = a.designData
          const parts = [`[Design Mode Selection: ${a.path}]`]
          if (d.outerHTML) parts.push(`Element: ${d.outerHTML.slice(0, 2000)}`)
          if (d.cssSelector) parts.push(`Selector: ${d.cssSelector}`)
          if (d.computedStyles) parts.push(`Styles: ${JSON.stringify(d.computedStyles)}`)
          if (d.componentName) parts.push(`Component: ${d.componentName}${d.componentFile ? ` (${d.componentFile})` : ''}`)
          if (d.pageURL) parts.push(`Page: ${d.pageURL}`)
          if (d.annotations?.length) {
            parts.push(`Annotations: ${d.annotations.map((ann, idx) => `[${ann.label ?? idx + 1}] ${ann.type}`).join(', ')}`)
          }
          return parts.join('\n')
        }
        return `[Attached ${a.type}: ${a.path}]`
      }).join('\n')
      fullPrompt = `${attachmentCtx}\n\n${fullPrompt}`
    }
    return fullPrompt
  }

  /** Image attachments to send as real content blocks. Only images with a
   *  base64 `dataUrl` qualify; everything else stays a text reference. */
  composeImages(input: InputState): Array<{ mimeType: string; dataUrl: string }> {
    return input.attachments
      .filter((a) => a.type === 'image' && !!a.dataUrl)
      .map((a) => ({ mimeType: a.mimeType ?? 'image/png', dataUrl: a.dataUrl! }))
  }
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
