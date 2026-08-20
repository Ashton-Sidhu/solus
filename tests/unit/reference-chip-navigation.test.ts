import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const workspaceUiRoot = join(import.meta.dir, '../../packages/workspace-ui/src')

function readWorkspaceFile(path: string): string {
  return readFileSync(join(workspaceUiRoot, path), 'utf8')
}

describe('reference chip navigation', () => {
  test('autocomplete chips preserve the composing page in the leading pane', () => {
    // WHY: clicking a reference while composing must show its target beside the
    // current page. Replacing that page loses the context in which the chip was
    // inserted, and a file chip with no callback appears clickable but does nothing.
    const autocompleteHosts = [
      'components/input/InputBar.svelte',
      'components/tasks/TaskComposer.svelte',
      'components/tasks/task-page/TaskHeader.svelte',
      'components/automations/AutomationBuilder.svelte',
      'components/ui/prompt-composer/prompt-composer.svelte',
    ]
    const promptEditor = readWorkspaceFile('components/ui/PromptEditor.svelte')
    const documentPromptEditor = readWorkspaceFile(
      'components/editor/DocumentPromptEditor.svelte',
    )
    const navigation = readWorkspaceFile(
      'components/editor/reference-navigation.ts',
    )

    for (const path of autocompleteHosts) {
      const source = readWorkspaceFile(path)
      expect(source, path).not.toContain('onPlanRefClick=')
      expect(source, path).not.toContain('onWorkRefClick=')
      expect(source, path).not.toContain('onPrRefClick=')
      expect(source, path).not.toContain('onFileRefClick=')
    }

    expect(promptEditor).toContain('createReferenceNavigation(session')
    expect(documentPromptEditor).toContain('createReferenceNavigation(session')
    expect(navigation).toContain('{ secondary: true }')
    expect(navigation).toContain("target: 'aside'")
    expect(navigation).toContain('requestFilePreview({')
  })

  test('rendered href chips use the same companion-pane route', () => {
    // WHY: accepted autocomplete references render back as href chips. Their
    // navigation must not change when the draft becomes saved Markdown.
    const markdownLink = readWorkspaceFile('components/conversation/MarkdownLink.svelte')
    const workspace = readWorkspaceFile('contexts/workspace/workspace.context.svelte.ts')

    expect(markdownLink).toContain(
      'target: linkRoute.name === "task" ? "new" : "aside"',
    )
    expect(
      workspace.match(
        /secondary: opts\.target === 'aside' \|\| opts\.target === 'new'/g,
      ),
    ).toHaveLength(2)
  })
})
