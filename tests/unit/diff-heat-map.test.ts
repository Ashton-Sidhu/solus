import { describe, expect, test } from 'bun:test'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import {
  buildHeatMapTree,
  heatBreadcrumb,
  heatIntensity,
  heatNodeAtPath,
  layoutTreemap,
} from '../../src/renderer/components/diff/lib/heat-map'

function patchFor(entries: Array<{ path: string; added: number }>): FileDiffMetadata[] {
  const patch = entries
    .map(({ path, added }) => {
      const lines = Array.from({ length: added }, (_, i) => `+line ${i}`).join('\n')
      return [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,0 +1,${added} @@`,
        lines,
      ].join('\n')
    })
    .join('\n')
  return parsePatchFiles(patch).flatMap((part) => part.files)
}

const files = patchFor([
  { path: 'src/renderer/components/diff/DiffPanel.svelte', added: 30 },
  { path: 'src/renderer/components/diff/DiffToolbar.svelte', added: 10 },
  { path: 'src/main/control-plane.ts', added: 5 },
  { path: 'README.md', added: 1 },
])

describe('diff heat map tree', () => {
  test('aggregates additions and file counts up the folder chain', () => {
    const root = buildHeatMapTree(files)
    expect(root.changedFileCount).toBe(4)
    expect(root.totalFileCount).toBe(4)
    expect(root.additions).toBe(46)

    const src = root.children.find((c) => c.name.startsWith('src'))
    expect(src).toBeDefined()
    expect(src!.changedFileCount).toBe(3)
    expect(src!.additions).toBe(45)
  })

  test('collapses single-child folder chains so a drill is never a single entry', () => {
    const root = buildHeatMapTree(files)
    const src = root.children.find((c) => c.kind === 'folder' && c.path === 'src')!
    // src fans out into renderer/ and main/; each side is a straight chain
    // down to its populated folder, so the names read as joined paths.
    const names = src.children.map((c) => c.name).sort()
    expect(names).toEqual(['main', 'renderer/components/diff'])
  })

  test('sorts children hottest-first so the heat ranking is the reading order', () => {
    const root = buildHeatMapTree(files)
    const changes = root.children.map((c) => c.additions + c.deletions)
    expect(changes).toEqual([...changes].sort((a, b) => b - a))
  })

  test('resolves drill paths and breadcrumbs through collapsed chains', () => {
    const root = buildHeatMapTree(files)
    const diff = heatNodeAtPath(root, 'src/renderer/components/diff')
    expect(diff).not.toBeNull()
    expect(diff!.changedFileCount).toBe(2)

    const trail = heatBreadcrumb(root, 'src/renderer/components/diff')
    expect(trail.map((n) => n.path)).toEqual(['src', 'src/renderer/components/diff'])

    expect(heatNodeAtPath(root, 'no/such/folder')).toBeNull()
  })

  test('heat intensity is log-scaled and relative to the hottest sibling', () => {
    const root = buildHeatMapTree(files)
    const hottest = root.children[0]
    const max = hottest.additions + hottest.deletions
    expect(heatIntensity(hottest, max)).toBe(1)
    const readme = root.children.find((c) => c.name === 'README.md')!
    const cool = heatIntensity(readme, max)
    expect(cool).toBeGreaterThan(0)
    // Log scaling keeps a 1-line change visible instead of rounding to zero.
    expect(cool).toBeGreaterThan(1 / max)
    expect(cool).toBeLessThan(1)
  })
})

describe('repo listing merge', () => {
  const repoPaths = [
    'src/renderer/components/diff/DiffPanel.svelte',
    'src/renderer/components/diff/DiffStream.svelte',
    'src/renderer/index.ts',
    'src/main/control-plane.ts',
    'docs/adr/0001-example.md',
    'README.md',
  ]

  test('unchanged repo folders and files appear with zero heat', () => {
    const root = buildHeatMapTree(files, repoPaths)
    const docs = root.children.find((c) => c.name === 'docs/adr')
    expect(docs).toBeDefined()
    expect(docs!.changed).toBe(false)
    expect(docs!.additions).toBe(0)
    expect(docs!.totalFileCount).toBe(1)
    expect(docs!.changedFileCount).toBe(0)
  })

  test('changed and unchanged files merge without double counting', () => {
    const root = buildHeatMapTree(files, repoPaths)
    // 4 changed (one of which is also in the repo listing) + 3 repo-only.
    expect(root.totalFileCount).toBe(7)
    expect(root.changedFileCount).toBe(4)
    expect(root.additions).toBe(46)

    const diff = heatNodeAtPath(root, 'src/renderer/components/diff')!
    expect(diff.totalFileCount).toBe(3)
    expect(diff.changedFileCount).toBe(2)
  })

  test('chain collapse respects real repo structure, not just the changed slice', () => {
    const root = buildHeatMapTree(files, repoPaths)
    const src = root.children.find((c) => c.path === 'src')!
    // The repo has src/renderer/index.ts, so renderer no longer collapses all
    // the way into components/diff — the level genuinely fans out there.
    const renderer = src.children.find((c) => c.name === 'renderer')
    expect(renderer).toBeDefined()
    expect(renderer!.children.map((c) => c.name).sort()).toEqual([
      'components/diff',
      'index.ts',
    ])
  })

  test('changed entries sort ahead of larger unchanged ones', () => {
    const root = buildHeatMapTree(files, repoPaths)
    const changedFlags = root.children.map((c) => c.changed)
    const firstUnchanged = changedFlags.indexOf(false)
    if (firstUnchanged !== -1) {
      expect(changedFlags.slice(firstUnchanged).every((flag) => !flag)).toBe(true)
    }
  })
})

describe('treemap layout', () => {
  test('tiles exactly fill the container with sqrt-damped proportional areas', () => {
    const root = buildHeatMapTree(files)
    const rects = layoutTreemap(root.children, 400, 300)
    expect(rects.length).toBe(root.children.length)

    const area = rects.reduce((sum, r) => sum + r.width * r.height, 0)
    expect(area).toBeCloseTo(400 * 300, 3)

    for (const rect of rects) {
      expect(rect.left).toBeGreaterThanOrEqual(-1e-6)
      expect(rect.top).toBeGreaterThanOrEqual(-1e-6)
      expect(rect.left + rect.width).toBeLessThanOrEqual(400 + 1e-6)
      expect(rect.top + rect.height).toBeLessThanOrEqual(300 + 1e-6)
    }

    // Areas follow sqrt(changes + files), not raw changes: a dominant folder
    // reads biggest without crushing small siblings into unreadable slivers.
    const srcRect = rects.find((r) => r.node.path === 'src')!
    const readmeRect = rects.find((r) => r.node.path === 'README.md')!
    const ratio = (srcRect.width * srcRect.height) / (readmeRect.width * readmeRect.height)
    expect(ratio).toBeCloseTo(Math.sqrt(45 + 3) / Math.sqrt(1 + 1), 3)
  })

  test('unchanged folders keep an area proportional to their repo size', () => {
    const root = buildHeatMapTree(files, [
      'README.md',
      ...Array.from({ length: 24 }, (_, i) => `vendor/dep/${i}.js`),
    ])
    const rects = layoutTreemap(root.children, 400, 300)
    const vendor = rects.find((r) => r.node.path === 'vendor/dep')!
    expect(vendor.node.changed).toBe(false)
    // 24 files → weight sqrt(24); visible, not a sliver.
    expect(vendor.width * vendor.height).toBeGreaterThan(400 * 300 * 0.1)
  })

  test('returns nothing for an empty level or a collapsed container', () => {
    expect(layoutTreemap([], 400, 300)).toEqual([])
    const root = buildHeatMapTree(files)
    expect(layoutTreemap(root.children, 0, 0)).toEqual([])
  })
})
