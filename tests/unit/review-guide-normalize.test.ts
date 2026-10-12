import { describe, expect, test } from 'bun:test'
import { normalizeGuide, parseGuideArgs, type SubmittedGuide } from '@solus/server/review/review-guide-tool'

// Two hunks in one file, one in another, and a deleted file. The guide quotes
// only what the patch holds, so the reader's line numbers are always real.
const patch = [
  'diff --git a/src/limit.ts b/src/limit.ts',
  'index 1111111..2222222 100644',
  '--- a/src/limit.ts',
  '+++ b/src/limit.ts',
  '@@ -3,3 +3,4 @@ export function limit() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' return a',
  '@@ -40,2 +41,2 @@ function later() {',
  '-old()',
  '+renamed()',
  ' end()',
  'diff --git a/src/use.ts b/src/use.ts',
  'index 3333333..4444444 100644',
  '--- a/src/use.ts',
  '+++ b/src/use.ts',
  '@@ -1 +1 @@',
  '-limit(1)',
  '+limit(2)',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 5555555..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
].join('\n')

function submitted(sections: SubmittedGuide['sections']): SubmittedGuide {
  return { title: 'Limit', summary: 'Adds a limit.', sections }
}

function section(id: string, files: SubmittedGuide['sections'][number]['files'], extra: Partial<SubmittedGuide['sections'][number]> = {}) {
  return { id, title: id, order: 0, significance: 'core' as const, explanation: 'Why.', files, ...extra }
}

describe('normalizeGuide', () => {
  test('quotes only the hunks a range touches, verbatim from the patch, with counts from the patch', () => {
    const guide = normalizeGuide(submitted([
      section('limit', [{ path: 'src/limit.ts', ranges: [{ side: 'new', start: 5, end: 5 }] }]),
      section('rest', [{ path: 'src/use.ts', ranges: [] }, { path: 'src/gone.ts', ranges: [] }]),
    ]), { patch })

    const file = guide.sections[0].files[0]
    expect(file).toMatchObject({ path: 'src/limit.ts', additions: 3, deletions: 2 })
    expect(file.hunks).toContain('@@ -3,3 +3,4 @@')
    expect(file.hunks).toContain('+const c = 4')
    expect(file.hunks).not.toContain('@@ -40,2 +41,2 @@')
    expect(file.hunks?.startsWith('diff --git a/src/limit.ts b/src/limit.ts')).toBe(true)
  })

  test('an old-side range picks the hunk that deleted those lines', () => {
    const guide = normalizeGuide(submitted([
      section('later', [{ path: 'src/limit.ts', ranges: [{ side: 'old', start: 40, end: 40 }] }]),
      section('rest', [{ path: 'src/use.ts', ranges: [] }, { path: 'src/gone.ts', ranges: [] }]),
    ]), { patch })

    expect(guide.sections[0].files[0].hunks).toContain('-old()')
    expect(guide.sections[0].files[0].hunks).not.toContain('+const c = 4')
  })

  test('shows the whole file when no range lands on a hunk, or every hunk is touched', () => {
    const guide = normalizeGuide(submitted([
      section('outside', [{ path: 'src/limit.ts', ranges: [{ side: 'new', start: 200, end: 210 }] }]),
      section('all', [{ path: 'src/limit.ts', ranges: [{ side: 'new', start: 1, end: 100 }] }]),
      section('rest', [{ path: 'src/use.ts', ranges: [] }, { path: 'src/gone.ts', ranges: [] }]),
    ]), { patch })

    expect(guide.sections[0].files[0].hunks).toBeUndefined()
    expect(guide.sections[1].files[0].hunks).toBeUndefined()
  })

  test('drops a file the change does not contain, and still accounts for every changed file', () => {
    const guide = normalizeGuide(submitted([
      section('limit', [{ path: 'src/limit.ts', ranges: [] }, { path: 'src/invented.ts', ranges: [] }]),
    ]), { patch })

    expect(guide.sections[0].files.map((f) => f.path)).toEqual(['src/limit.ts'])
    const remaining = guide.sections.at(-1)
    expect(remaining).toMatchObject({ id: 'remaining-changes', significance: 'low-signal' })
    expect(remaining?.files).toEqual([
      { path: 'src/use.ts', additions: 1, deletions: 1 },
      { path: 'src/gone.ts', additions: 0, deletions: 2 },
    ])
  })

  test('keeps attention only where the agent set it, and orders sections by band', () => {
    const guide = normalizeGuide(submitted([
      section('plumbing', [{ path: 'src/use.ts', ranges: [] }], { significance: 'low-signal' }),
      section('limit', [{ path: 'src/limit.ts', ranges: [] }, { path: 'src/gone.ts', ranges: [] }], {
        attention: { kind: 'tradeoff', note: 'Fails open while Redis is down.' },
      }),
    ]), { patch })

    expect(guide.sections.map((s) => [s.id, s.order])).toEqual([['limit', 0], ['plumbing', 1]])
    expect(guide.sections[0].attention).toEqual({ kind: 'tradeoff', note: 'Fails open while Redis is down.' })
    expect('attention' in guide.sections[1]).toBe(false)
  })
})

describe('parseGuideArgs', () => {
  test('rejects copied hunk text in place of line ranges, so a stale agent cannot store drifting diffs', () => {
    const result = parseGuideArgs({
      title: 'T', summary: 'S',
      sections: [{ id: 'a', title: 'A', order: 0, significance: 'core', explanation: 'E',
        files: [{ path: 'src/use.ts', hunks: '@@ -1 +1 @@' }] }],
    })
    expect(result.ok).toBe(false)
  })

  test('rejects an attention kind outside the decision vocabulary', () => {
    const result = parseGuideArgs({
      title: 'T', summary: 'S',
      sections: [{ id: 'a', title: 'A', order: 0, significance: 'core', explanation: 'E',
        attention: { kind: 'bug', note: 'Off by one.' }, files: [] }],
    })
    expect(result.ok).toBe(false)
  })
})
