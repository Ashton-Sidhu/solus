import { expect, test } from 'bun:test'
import { filterChangedFiles, toggleChangeKind, parseChangeKinds, changeFilterOptions } from '@solus/client-core/change-breakdown'
import { buildReviewParsedDiff } from '../../apps/mobile/src/features/review/reviewModel'
import { filterPullRequestFileKinds } from '../../apps/mobile/src/features/prs/lib/pull-request-file-filters'

const paths = ['src/app.ts', 'tests/app.test.ts', 'tests/fixtures/app.json', 'bun.lock', 'README.md']

test('filters each class with the existing classification and preserves file identity', () => {
  const files = paths.map((path) => ({ path }))
  expect(filterChangedFiles(files, null, (file) => file.path)).toBe(files)
  for (const [index, kind] of ['code', 'tests', 'mocks', 'generated', 'docs'].entries()) {
    const option = changeFilterOptions(paths.map((path) => ({ path, additions: 1, deletions: 0 })))[index]!
    expect(option.kind).toBe(kind)
    expect(option.additions).toBe(1)
    expect(filterChangedFiles(files, [option.kind], (file) => file.path)[0]).toBe(files[index])
  }
  expect(filterChangedFiles([], ['docs'], (path: string) => path)).toEqual([])
})

test('native filtering keeps comment anchors and makes a targeted file visible', () => {
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


test('checkboxes combine classes, allow none, and restore all', () => {
  const files = paths.map((path) => ({ path }))
  expect(filterChangedFiles(files, ['code', 'docs'], (file) => file.path)).toEqual([files[0], files[4]])
  expect(filterChangedFiles(files, [], (file) => file.path)).toEqual([])
  expect(toggleChangeKind(null, 'tests')).toEqual(['code', 'mocks', 'generated', 'docs'])
  expect(toggleChangeKind(['code', 'mocks', 'generated', 'docs'], 'tests')).toBeNull()
  expect(toggleChangeKind(['docs'], 'docs')).toEqual([])
  expect(toggleChangeKind([], 'docs')).toEqual(['docs'])
})

test('saved choices accept older clients and preserve an empty selection', () => {
  expect(parseChangeKinds('docs')).toEqual(['docs'])
  expect(parseChangeKinds('all')).toBeNull()
  expect(parseChangeKinds('[]')).toEqual([])
  expect(parseChangeKinds('["docs","code"]')).toEqual(['code', 'docs'])
  expect(parseChangeKinds('["removed"]')).toBeNull()
})

test('menu classes stay available for a single binary file and an empty diff', () => {
  expect(changeFilterOptions([{ path: 'README.md', additions: 0, deletions: 0 }])).toHaveLength(5)
  expect(changeFilterOptions([])).toHaveLength(5)
})
