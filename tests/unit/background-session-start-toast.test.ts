import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8')
}

describe('background session start feedback', () => {
  test('confirms a successful Cmd+Enter start from every shared draft surface', () => {
    // WHY: a background start does not activate its new tab or move the caret,
    // so the shared command must give immediate feedback wherever it is called.
    const workspace = source(
      'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts',
    )
    const method = workspace.slice(
      workspace.indexOf('  startDraftInBackground('),
      workspace.indexOf('  discardSessionDraft('),
    )

    expect(method).toContain("toasts.success('Session started in the background')")
    expect(
      source('packages/workspace-ui/src/components/layout/PillLayout.svelte'),
    ).toContain('session.startDraftInBackground(')
    expect(
      source('packages/workspace-ui/src/components/session-draft/SessionDraftPane.svelte'),
    ).toContain('session.startDraftInBackground(')
  })
})
