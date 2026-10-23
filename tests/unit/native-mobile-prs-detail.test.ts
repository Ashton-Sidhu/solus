import { describe, expect, test } from 'bun:test'
import { isBotBadgeImage } from '../../apps/mobile/src/features/prs/lib/bot-badge-images'
import { filterPullRequestFileKinds, pullRequestTabOffset } from '../../apps/mobile/src/features/prs/lib/pull-request-file-filters'
import { pullRequestAttachments, splitPullRequestBody } from '../../apps/mobile/src/features/prs/lib/pull-request-markdown'
import { buildNativeReviewDiffData } from '../../apps/mobile/src/features/review/nativeReviewDiffAdapter'
import { buildReviewParsedDiff } from '../../apps/mobile/src/features/review/reviewModel'

// Ported from T3 Code's pull request detail tests. The description shows each
// screenshot once and never turns a code example into media; the Files tab
// hides tests without moving comment anchors; a tab switch keeps the shared
// header where it was.

describe('pull request attachments (ported from T3)', () => {
  test('embedded images and standalone media come once each, in body order', () => {
    const uri = 'https://drop.example.com/shot.png'
    const body = [
      `![Screenshot](${uri})`,
      `![Duplicate](${uri})`,
      uri,
      'https://drop.example.com/demo.mp4',
      'https://github.com/user-attachments/assets/123-abc',
    ].join('\n\n')
    expect(pullRequestAttachments(body)).toEqual([
      { uri, caption: 'Screenshot', kind: 'image' },
      { uri: 'https://drop.example.com/demo.mp4', caption: 'Video', kind: 'video' },
      { uri: 'https://github.com/user-attachments/assets/123-abc', caption: 'Video', kind: 'video' },
    ])
  })

  test('code examples, ordinary links, comments, and local paths give no attachment', () => {
    const body = [
      'Fixes reconnects. See https://example.com/docs',
      '```markdown\n![Example](https://example.com/code.png)\nhttps://drop.example.com/demo.mp4\n```',
      'Inline `![x](https://example.com/inline.png)` code.',
      '    ![Indented](https://example.com/indented.png)',
      '<!-- ![Hidden](https://example.com/hidden.png) -->',
      '![Before](https://example.com/before.png)',
      '![Local](screenshots/local.png)',
    ].join('\n\n')
    expect(pullRequestAttachments(body)).toEqual([{ uri: 'https://example.com/before.png', caption: 'Before', kind: 'image' }])
  })

  test('a dropped image, which GitHub writes as an <img> tag, is an attachment with its alt text', () => {
    expect(pullRequestAttachments('<img width="300" alt="After" src="https://github.com/user-attachments/assets/9f1">'))
      .toEqual([{ uri: 'https://github.com/user-attachments/assets/9f1', caption: 'After', kind: 'image' }])
  })

  test('bot badges stay out of the strip', () => {
    const body = '![Review](https://img.shields.io/badge/P1-orange)\n\n![Screen](https://app.devin.ai/attachments/abc/ss_1.png)'
    expect(pullRequestAttachments(body).map((attachment) => attachment.uri)).toEqual(['https://app.devin.ai/attachments/abc/ss_1.png'])
  })

  test('the body splits around standalone media; a fenced link stays Markdown', () => {
    const segments = splitPullRequestBody('Intro\n\nhttps://a.example/v.mp4\n\n```\nhttps://a.example/x.mp4\n```\n\n<video src="https://a.example/clip">\n</video>')
    expect(segments.map((segment) => segment.kind === 'attachment' ? `${segment.media}:${segment.url}` : segment.text)).toEqual([
      'Intro',
      'video:https://a.example/v.mp4',
      '```\nhttps://a.example/x.mp4\n```',
      'video:https://a.example/clip',
    ])
  })
})

describe('bot badge images (ported from T3)', () => {
  test('matches bot badges but not screenshots on the same services', () => {
    const badges = [
      'https://static.devin.ai/assets/gh-devin-review-light.svg?v=4',
      'https://cursor.com/assets/images/open-in-web-dark.png',
      'https://storage.googleapis.com/coderabbit_public_assets/review-stack-in-coderabbit-ui.svg',
      'https://img.shields.io/badge/P1-orange',
      'https://greptile-static-assets.s3.amazonaws.com/badges/ViewArtifacts.svg?v=4',
      'https://www.gstatic.com/codereviewagent/high-priority.svg',
      'https://user-images.githubusercontent.com/23264/106598434-9e719e00-654f-11eb-9e59-6167043cfa01.png',
    ]
    const screenshots = [
      'https://cursor.com/artifacts/c/art-41567e7e-97f5-46ff-9e6e-df6a85723409',
      'https://www.cursor.com/artifacts/c/art-98360ed1-44f8-4459-bea3-43bf93cc74fc',
      'https://app.devin.ai/attachments/abc/ss_1.png',
      'https://user-images.githubusercontent.com/23264/1-other-upload.png',
      'https://storage.googleapis.com/some-bucket/before.png',
    ]
    expect(badges.filter(isBotBadgeImage)).toEqual(badges)
    expect(screenshots.filter(isBotBadgeImage)).toEqual([])
  })
})

const patch = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`

describe('pull request test file filter (ported from T3)', () => {
  test('removes whole test files and keeps the source files and their line anchors', () => {
    const parsed = buildReviewParsedDiff(['src/first.test.ts', 'src/first.ts', 'src/__tests__/second.ts', 'src/second.ts'].map(patch).join('\n'), 'pr-filter-1')
    const visible = filterPullRequestFileKinds(parsed, ['code'])
    if (parsed.kind !== 'files' || visible.kind !== 'files') throw new Error('Expected files')
    expect(visible.files.map((file) => file.path)).toEqual(['src/first.ts', 'src/second.ts'])
    expect([visible.fileCount, visible.additions, visible.deletions]).toEqual([2, 2, 2])
    expect(visible.files[0]).toBe(parsed.files[1]!)
    const allRows = buildNativeReviewDiffData(parsed).rows
    const visibleIds = new Set(visible.files.map((file) => file.id))
    expect(buildNativeReviewDiffData(visible).rows).toEqual(allRows.filter((row) => visibleIds.has(row.fileId ?? '')))
    expect(filterPullRequestFileKinds(parsed, null)).toBe(parsed)
  })

  test('a guide target that is a test stays visible; other tests stay hidden', () => {
    const parsed = buildReviewParsedDiff(['src/first.test.ts', 'src/app.ts', 'src/second.test.ts'].map(patch).join('\n'), 'pr-filter-2')
    const visible = filterPullRequestFileKinds(parsed, ['code'], 'src/second.test.ts')
    if (visible.kind !== 'files') throw new Error('Expected files')
    expect(visible.files.map((file) => file.path)).toEqual(['src/app.ts', 'src/second.test.ts'])
  })

  test('an all-test diff is empty files, not a missing diff', () => {
    const parsed = buildReviewParsedDiff(patch('src/app.test.ts'), 'pr-filter-3')
    expect(filterPullRequestFileKinds(parsed, ['code'])).toMatchObject({ kind: 'files', files: [], fileCount: 0 })
    const empty = { kind: 'empty' as const }
    expect(filterPullRequestFileKinds(empty, ['code'])).toBe(empty)
  })
})

describe('pull request tab scroll (ported from T3)', () => {
  test('the header stays in place while it is in view, whatever the other tab scrolled', () => {
    expect(pullRequestTabOffset(-100, 900, 200)).toBe(-100)
    expect(pullRequestTabOffset(75, 900, 200)).toBe(75)
  })
  test('after the header scrolled away, each tab goes back to its own position', () => {
    expect(pullRequestTabOffset(600, 900, 200)).toBe(900)
    expect(pullRequestTabOffset(600, 50, 200)).toBe(200)
    expect(pullRequestTabOffset(600, undefined, 200)).toBe(200)
  })
})
