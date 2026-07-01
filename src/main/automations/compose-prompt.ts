import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadWork } from '../folio/works'
import type { AutomationAction, Work } from '../../shared/types'

// Mirrors the renderer's PromptComposer: plan/work references are rendered as
// pointer blocks appended to the prompt. Plans use the source captured at save
// time; works are located fresh so the agent always reads the latest file.

function workFilePath(work: Work): string {
  const fileName = `${work.id}.json`
  if (work.storage?.kind === 'project') {
    const base = work.storage.projectRoot
      ? join(work.storage.projectRoot, work.storage.relativePath)
      : work.storage.relativePath
    return join(base, fileName)
  }
  return join(homedir(), '.solus', 'works', fileName)
}

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
    const work = await loadWork(ref.workId, action.cwd).catch(() => null)
    const parts = [`[Referenced Work: ${ref.title}]`, `Type: ${work?.type ?? ref.type}`]
    if (work) parts.push(`File path: ${workFilePath(work)}`)
    else parts.push('(Work unavailable — it may have been deleted)')
    blocks.push(parts.join('\n'))
  }

  if (blocks.length === 0) return action.prompt
  const context = blocks.join('\n\n')
  return action.prompt ? `${action.prompt}\n\n${context}` : context
}
