import { afterEach, describe, expect, test } from 'bun:test'
import type { ReviewLensSnapshot } from '@solus/contracts/review'
import {
  anchorReplySchema,
  commentableNewLines,
  draftLineRefusal,
  lensTabState,
  parseAnchorReply,
  savedLensFromPrompt,
} from '../../packages/workspace-ui/src/components/review/lib/lens-surface'
import { wrapSandboxSrcdoc } from '../../packages/workspace-ui/src/lib/artifactSandbox'

// docs/plans/review-lenses.md: a lens comment becomes a PR line comment only
// when its anchor is a real line in the diff, and lens HTML runs with no network.

const PATCH = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,4 +10,5 @@ export function refresh() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' return a',
  'diff --git a/src/other.ts b/src/other.ts',
  '--- a/src/other.ts',
  '+++ b/src/other.ts',
  '@@ -1,1 +1,1 @@',
  '-x',
  '+y',
].join('\n')

describe('lens code anchors', () => {
  test('commentable lines are the new-side added and context lines inside hunks', () => {
    expect([...commentableNewLines(PATCH, 'src/auth.ts')]).toEqual([10, 11, 12, 13])
    expect([...commentableNewLines(PATCH, 'src/other.ts')]).toEqual([1])
    expect(commentableNewLines(PATCH, 'src/missing.ts').size).toBe(0)
  })

  test('a draft line comment is refused outside the diff, before the diff loads, or on a line that has a draft', () => {
    expect(draftLineRefusal({ path: 'src/auth.ts', line: 12 }, PATCH, [])).toBeNull()
    expect(draftLineRefusal(undefined, PATCH, [])).toContain('does not point at a line')
    expect(draftLineRefusal({ path: 'src/auth.ts', line: 99 }, PATCH, [])).toContain('not a line in this diff')
    expect(draftLineRefusal({ path: 'src/auth.ts', line: 12 }, null, [])).toContain('still loading')
    expect(draftLineRefusal({ path: 'src/auth.ts', line: 12 }, PATCH, [{ path: 'src/auth.ts', line: 12, side: 'new' }]))
      .toContain('already a draft')
  })

  test('an anchor reported by the render is kept only when it is a relative path and a positive line', () => {
    const reply = (fields: { path?: unknown; line?: unknown; text?: unknown }) =>
      parseAnchorReply(anchorReplySchema.parse({ type: 'solus-lens-anchor', id: 'q1', ...fields }))
    expect(reply({ path: 'src/auth.ts', line: 12, text: ' Token refresh ' }))
      .toEqual({ codeAnchor: { path: 'src/auth.ts', line: 12 }, quote: 'Token refresh' })
    expect(reply({ path: '/etc/passwd', line: 1 })).toEqual({})
    expect(reply({ path: '../secret', line: 1 })).toEqual({})
    expect(reply({ path: 'a.ts', line: 0 })).toEqual({})
    // A malformed field costs the anchor, not the comment's quote.
    expect(reply({ path: 'a.ts', line: '3', text: 'Box' })).toEqual({ quote: 'Box' })
    expect(anchorReplySchema.safeParse({ type: 'other', id: 'q1' }).success).toBe(false)
  })
})

describe('lens tab state', () => {
  const base: ReviewLensSnapshot = {
    repoRoot: '/repo', key: 'k', target: { kind: 'branch' }, current: null,
    hasPrevious: false, outdated: false, job: null, revision: 0,
  }
  const lens = {
    lens: {
      version: 1 as const, key: 'k', target: { kind: 'branch' as const }, headSha: 'h', baseSha: 'b',
      changeFingerprint: 'f', generatedAt: '2026-09-25T00:00:00Z', source: { name: 'n', prompt: 'p' },
      edits: [], title: 't', html: '<p/>',
    },
    comments: [],
  }

  test('a running job wins, then a failure, then unread, then the quiet states', () => {
    expect(lensTabState(null, false)).toBe('absent')
    expect(lensTabState({ ...base, job: { kind: 'generate', status: 'generating', updatedAt: 1 } }, true)).toBe('generating')
    expect(lensTabState({ ...base, current: lens, job: { kind: 'edit', status: 'failed', updatedAt: 1 } }, true)).toBe('attention')
    expect(lensTabState({ ...base, current: lens }, true)).toBe('unread')
    expect(lensTabState({ ...base, current: lens }, false)).toBe('ready')
  })
})

describe('saved lens from a one-time prompt', () => {
  test('is named by its first line and keeps the whole prompt', () => {
    const lens = savedLensFromPrompt('Show risk per file\nRank by blast radius')
    expect(lens.name).toBe('Show risk per file')
    expect(lens.prompt).toBe('Show risk per file\nRank by blast radius')
    expect(lens.id).toBeString()
    expect(savedLensFromPrompt('x'.repeat(80)).name.length).toBeLessThanOrEqual(48)
  })
})

describe('isolated sandbox', () => {
  const previousDocument = globalThis.document
  const previousGetComputedStyle = globalThis.getComputedStyle
  afterEach(() => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
    Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: previousGetComputedStyle })
  })

  test('a lens frame gets no network and answers anchor queries; other renders keep their policy', () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } })
    Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '' }) })
    const isolated = wrapSandboxSrcdoc('<p>lens</p>', false, true)
    const csp = isolated.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).not.toContain('https:')
    expect(isolated).toContain('solus-lens-anchor-query')

    const normal = wrapSandboxSrcdoc('<p>artifact</p>', false)
    expect(normal).toContain('connect-src https:')
    expect(normal).not.toContain('solus-lens-anchor-query')
  })
})
