import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const gitSection = readFileSync(
  join(root, 'packages/workspace-ui/src/components/project-panel/GitSection.svelte'),
  'utf8',
)
const workspaceContext = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)

describe('project panel review action', () => {
  test('opens the diff by default and resumes an existing guide', () => {
    // WHY: Review changes is a reading action. It must not start background
    // work or land on an empty guide unless a guide already exists.
    expect(gitSection).toContain('if (reviewKey) session.openReviewGuide({ kind: "branch" }, sourceId)')
    expect(gitSection).toContain('else session.enterReview("branch", sourceId, "diff")')
    expect(workspaceContext).toContain("view: ReviewView = 'diff'")
  })

  test('keeps every review destination in the row menu', () => {
    // WHY: Map, guide generation, and diff are peer review actions. The user
    // must be able to choose any of them without first opening a review pane.
    expect(gitSection).toContain('popRow("Open map"')
    expect(gitSection).toContain('? "Regenerate guide"')
    expect(gitSection).toContain(': "Generate review guide"')
    expect(gitSection).toContain('popRow("Open diff"')
  })

  test('opens the diff pane at sixty percent', () => {
    // WHY: Changes need more reading space than the conversation when the diff
    // first opens, while still keeping the conversation visible beside it.
    expect(workspaceContext).toContain("this.showViewer({ name: 'review', params })")
    expect(workspaceContext).toContain('pane.defaultSize = 60')
  })
})
