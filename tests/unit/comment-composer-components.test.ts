import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const COMPONENTS = join(
  import.meta.dir,
  '../../packages/workspace-ui/src/components',
)

function source(path: string): string {
  return readFileSync(join(COMPONENTS, path), 'utf8')
}

describe('shared comment components', () => {
  test('browser and diagram entry keep their shells but share the comment workflow', () => {
    // WHY: marks and diagram anchors need distinct placement and context, but
    // separate editors drift in shortcuts, attachment support, and actions.
    const browser = source('browser/BrowserCommentPopup.svelte')
    const diagram = source('diagram/DiagramCommentsPanel.svelte')

    expect(browser).toContain('<CommentComposer')
    expect(browser).toContain('surface="compact"')
    expect(browser).not.toContain('<textarea')
    expect(diagram).toContain('<CommentComposer')
    expect(diagram).toContain('surface="embedded"')
    expect(diagram).not.toContain('<Textarea')
  })

  test('task and PR activity use one posting bar', () => {
    // WHY: these two persistent composers intentionally have the same pill,
    // focus ring, shortcut, upload state, and send affordance.
    const task = source('tasks/task-page/TaskCommentComposer.svelte')
    const activity = source('pr-review/ActivityFeed.svelte')

    expect(task).toContain('<CommentPostingBar')
    expect(activity).toContain('<CommentPostingBar')
    expect(task).not.toContain('<CommentEditor')
    expect(activity).not.toContain('<CommentEditor')
  })

  test('the recorder shares the action row with cancel and submit', () => {
    // WHY: in the field, the mic tracks the centre of a box that grows as you
    // type, so it drifts away from the controls it belongs with. The one
    // exception is the compact surface, which hides the action row until there
    // is content — its mic must stay in the field to dictate the first word.
    const composer = source('ui/comment-composer/comment-composer.svelte')
    const actionsStart = composer.indexOf('{#snippet actions()}')
    const actions = composer.slice(
      actionsStart,
      composer.indexOf('{/snippet}', actionsStart),
    )

    expect(actions).toContain('<EditorVoiceControl')
    expect(composer).toContain('mic={micInField}')
    expect(composer).toContain('resolvedSurface === "compact"')
  })

  test('thread replies use the contextual composer', () => {
    // WHY: local and remote review threads must have the same cancel, submit,
    // disabled, attachment, and keyboard behavior.
    expect(source('diff/DiffThreadComment.svelte')).toContain('<CommentComposer')
    expect(source('pr-review/PrThreadCard.svelte')).toContain('<CommentComposer')
  })
})
