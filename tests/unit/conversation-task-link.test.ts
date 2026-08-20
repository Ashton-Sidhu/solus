import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const markdownLink = readFileSync(
  join(root, 'packages/workspace-ui/src/components/conversation/MarkdownLink.svelte'),
  'utf8',
)
const markdownSanitizer = readFileSync(
  join(root, 'packages/workspace-ui/src/lib/markdownSanitize.ts'),
  'utf8',
)
const workspace = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)

describe('conversation task links', () => {
  test('preserves task references for the in-app link renderer', () => {
    // WHY: replacing task:// with an empty href makes the browser reload the
    // current page instead of giving MarkdownLink the task destination.
    expect(markdownSanitizer).toMatch(/ALLOWED_CUSTOM_PROTOCOLS = .*\btask\b/)
  })

  test('requests a new companion pane for a task route', () => {
    // WHY: opening the task in the leading pane removes the conversation that
    // provides its context.
    expect(markdownLink).toContain('linkRoute.name === "task"')
    expect(markdownLink).toContain('? "new"')
    expect(workspace).toContain("case 'task':")
    expect(workspace).toContain("this.showPage(ref, opts.via ?? 'click', 'tasks', opts.target)")
  })
})
