import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const composerSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/task-page/TaskCommentComposer.svelte'),
  'utf8',
)
const feedSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/task-page/TaskActivityFeed.svelte'),
  'utf8',
)
const prActivitySource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte'),
  'utf8',
)
const prTimelineSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/pr-review/ActivityTimeline.svelte'),
  'utf8',
)
const prThreadSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/pr-review/PrThreadCard.svelte'),
  'utf8',
)
const submitReviewSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/pr-review/SubmitReviewModal.svelte'),
  'utf8',
)
const commentEditorSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/ui/comment-editor/comment-editor.svelte'),
  'utf8',
)
const commentComposerSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/ui/comment-composer/comment-composer.svelte'),
  'utf8',
)
const diffStreamSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/diff/DiffStream.svelte'),
  'utf8',
)
const guideFileDiffSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/pr-review/guide/GuideFileDiff.svelte'),
  'utf8',
)
const diffThreadCommentSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/diff/DiffThreadComment.svelte'),
  'utf8',
)

describe('task comment Markdown', () => {
  test('routes task comments through the shared lightweight Markdown input', () => {
    // WHY: comments only need to preserve Markdown source while typing. The
    // full document editor adds rich-document behavior that comments do not use.
    expect(composerSource).toContain('import { CommentEditor }')
    expect(composerSource).toContain('<CommentEditor')
    expect(commentEditorSource).toContain('import PlainTextEditor')
  })

  test('uses a person glyph instead of a generated Y for the local user', () => {
    expect(feedSource).toContain('UserRound as UserIcon')
    expect(feedSource).toMatch(/{#if user}\s*<UserIcon/)
  })

  test('renders posted task comments through the shared Markdown pipeline', () => {
    expect(feedSource).toContain('<SvelteMarkdown')
    expect(feedSource).toContain('extensions={githubMarkdownExtensions}')
    expect(feedSource).toContain('renderers={taskMarkdownRenderers}')
  })
})

describe('pull request comment Markdown', () => {
  test('routes every PR comment composer through the same lightweight input', () => {
    expect(commentEditorSource).toContain('import PlainTextEditor')
    expect(prActivitySource).toContain('<CommentEditor')
    expect(submitReviewSource).toContain('<CommentEditor')
    expect(prThreadSource).toContain('<CommentEditor')
    expect(commentComposerSource).toContain('import { CommentEditor }')
    expect(diffStreamSource).toContain('<CommentComposer')
    expect(guideFileDiffSource).toContain('<CommentComposer')
    expect(diffThreadCommentSource).toContain('<CommentEditor')
  })

  test('renders top-level comments and thread replies as Markdown', () => {
    // WHY: preserving Markdown at input is only useful if every posted PR
    // comment surface sends the body through the shared GitHub renderer.
    for (const source of [prTimelineSource, prThreadSource, diffThreadCommentSource]) {
      expect(source).toContain('<SvelteMarkdown')
      expect(source).toContain('extensions={githubMarkdownExtensions}')
      expect(source).toContain('renderers={githubMarkdownRenderers}')
    }
  })
})
