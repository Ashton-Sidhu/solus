import { expect, test } from 'bun:test'
import { parseInlineReviewGuide } from '@solus/contracts/inline-review-guide'
import { loadInlineReviewGuide, resolveInlineReviewGuide } from '@solus/client-core/inline-review-guide'
import { splitPatchByFile } from '../../packages/workspace-ui/src/components/pr-review/guide/lib/guide-data'
import { replySegments } from '@solus/document-model/reply-html-layout'

const draft = {
  title: 'Change the default',
  summary: 'The second turn restores the original default.',
  sections: [1, 2, 2, 3].map(turn => ({
    title: `Turn ${turn}`, significance: 'core' as const, explanation: 'Verify the default.',
    files: [{ path: 'settings', turn }],
  })),
}

test('each section shows the cited snapshot, including later reversals and missing snapshots', async () => {
  const source = ['diff --git a/settings b/settings', '--- a/settings', '+++ b/settings', '@@ -1 +1 @@'].join('\n')
  const patches = [source + '\n-old\n+new\n', source + '\n-new\n+old\n']
  const reads: number[] = []
  const { guide, unavailable } = await resolveInlineReviewGuide(draft, async index => {
    reads.push(index)
    return patches[index] ? { patch: patches[index] } : null
  }, splitPatchByFile)
  expect(reads).toEqual([0, 1, 2])
  expect(guide.sections.map(section => section.files[0].hunks)).toEqual([patches[0], patches[1], patches[1], undefined])
  expect(guide.sections[0].files[0]).toMatchObject({ additions: 1, deletions: 1 })
  expect(unavailable).toEqual([3])
})

test('the native reader recognizes a complete structured guide and leaves incomplete or invalid JSON as Markdown', () => {
  const open = '```review-guide\n' + JSON.stringify(draft)
  expect(replySegments(open)[0].kind).toBe('markdown')
  expect(replySegments(open + '\n```')[0]).toMatchObject({ kind: 'guide', guide: draft })
  expect(replySegments('```review-guide\n{}\n```')[0].kind).toBe('markdown')
  expect(parseInlineReviewGuide(JSON.stringify({ ...draft, sections: [{...draft.sections[0], files: [{path: 'settings', turn: 0}]}] }))).toBeNull()
})

test('a remounted reply reuses its pending and completed guide within one session reader', async () => {
  const reads: number[] = []
  const read = async (index: number) => { reads.push(index); return null }
  const first = loadInlineReviewGuide(draft, read, splitPatchByFile)
  expect(loadInlineReviewGuide(structuredClone(draft), read, splitPatchByFile)).toBe(first)
  await first.ready
  expect(loadInlineReviewGuide(structuredClone(draft), read, splitPatchByFile).value).toBe(first.value)
  expect(reads).toEqual([0, 1, 2])
  const retried = loadInlineReviewGuide(draft, read, splitPatchByFile, true)
  expect(retried).not.toBe(first)
  await retried.ready
  expect(reads).toEqual([0, 1, 2, 0, 1, 2])
  expect(loadInlineReviewGuide(draft, async () => null, splitPatchByFile)).not.toBe(retried)
})

test('a wrong path identifies the citation and does not offer to retry the snapshot', async () => {
  const result = await resolveInlineReviewGuide(draft, async () => ({patch: ''}), splitPatchByFile)
  expect(result.unavailable).toEqual([])
  expect(result.guide.sections[0].files[0]).toMatchObject({path: 'settings', missingFromTurn: 1})
})
