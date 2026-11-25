import { expect, test } from "vite-plus/test";
import { buildReviewParsedDiff } from "../../../../src/features/review/reviewModel";
import { filterPullRequestFileKinds } from "./pull-request-file-filters";

test('native filtering keeps comment anchors and makes a targeted file visible', () => {
  const paths = ['src/app.ts', 'tests/app.test.ts', 'tests/fixtures/app.json', 'bun.lock', 'README.md']
  const patch = paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join('')
  const parsed = buildReviewParsedDiff(patch, 'kind-filter')
  const visible = filterPullRequestFileKinds(parsed, ['docs'])
  expect(visible.kind).toBe('files')
  if (parsed.kind !== 'files' || visible.kind !== 'files') throw new Error('Expected files')
  expect(visible.files).toEqual([parsed.files[4]!])
  expect(visible.files[0]).toBe(parsed.files[4])
  expect(visible.additions).toBe(1)
  expect(filterPullRequestFileKinds(parsed, null)).toBe(parsed)
  const jumped = filterPullRequestFileKinds(parsed, ['docs'], paths[1])
  if (jumped.kind !== 'files') throw new Error('Expected files')
  expect(jumped.files).toEqual([parsed.files[1]!, parsed.files[4]!])
})
