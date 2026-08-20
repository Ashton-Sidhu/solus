import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workspaceSource = (path: string) =>
  readFileSync(new URL(`../../packages/workspace-ui/src/${path}`, import.meta.url), 'utf8')

describe('shared rich description editor', () => {
  test('PR and task descriptions use the document editor that owns block slash commands', () => {
    const prActivity = workspaceSource('components/pr-review/ActivityFeed.svelte')
    const taskComposer = workspaceSource('components/tasks/TaskComposer.svelte')
    const taskHeader = workspaceSource('components/tasks/task-page/TaskHeader.svelte')
    const promptEditor = workspaceSource('components/editor/DocumentPromptEditor.svelte')
    const documentEditor = workspaceSource('components/editor/DocumentEditor.svelte')

    expect(prActivity).toContain('class="pr-description-editor prose-pr prose-pr-description"')
    expect(taskComposer).toContain('<DocumentPromptEditor')
    expect(taskHeader).toContain('<DocumentPromptEditor')
    expect(promptEditor).toContain('<DocumentEditor')
    expect(documentEditor).toContain('<EditorSlashMenu')
  })

  test('plan editing reaches the same document editor through its shell', () => {
    const planModal = workspaceSource('components/plan/PlanModal.svelte')
    const documentShell = workspaceSource('components/document-shell/DocumentShell.svelte')

    expect(planModal).toContain('<DocumentShell')
    expect(documentShell).toContain('<DocumentEditor')
  })
})
