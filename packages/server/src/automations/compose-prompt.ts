import { loadWork } from '../folio/works'
import { LOCAL_ORGANIZATION_ID } from '../server/principal'
import type { AutomationAction } from '@solus/contracts/types'

// Mirrors the renderer's PromptComposer: plan/work references are rendered as
// pointer blocks appended to the prompt. Plans use the source captured at save
// time; a work is named by the id `read_work` takes, since it is a database
// row and not a file the agent could open.

/**
 * Expand an automation's plan (`#`) and work (`%`) references into context
 * blocks appended to its prompt. File (`@`) and skill (`/`) references stay
 * inline — the agent provider resolves those natively.
 */
export async function composeAutomationPrompt(action: AutomationAction): Promise<string> {
  const blocks: string[] = []

  for (const ref of action.planRefs ?? []) {
    if (ref.filePath) {
      blocks.push(`[Referenced Plan: ${ref.title}]\nFile path: ${ref.filePath}`)
    } else {
      blocks.push(`[Referenced Plan: ${ref.title}]\n${ref.content || '(Plan content unavailable)'}`)
    }
  }

  for (const ref of action.workRefs ?? []) {
    const work = await loadWork(LOCAL_ORGANIZATION_ID, ref.workId).catch(() => null)
    const parts = [`[Referenced Work: ${ref.title}]`, `Type: ${work?.type ?? ref.type}`]
    if (work) parts.push(`Work id: ${work.id} (read it with read_work)`)
    else parts.push('(Work unavailable — it may have been deleted)')
    blocks.push(parts.join('\n'))
  }

  if (blocks.length === 0) return action.prompt
  const context = blocks.join('\n\n')
  return action.prompt ? `${action.prompt}\n\n${context}` : context
}
