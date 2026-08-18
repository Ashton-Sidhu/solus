import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const skeletonSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/diff/DiffLoadingSkeleton.svelte'),
  'utf8',
)

describe('diff loading skeleton', () => {
  test('matches the loaded diff screen geometry', () => {
    // WHY: the loaded diff uses a 290px file tree above 640px and a flexible
    // stream beside it. The loading state must keep those columns stable.
    expect(skeletonSource).toContain('@container')
    expect(skeletonSource).toContain('@max-[39.999rem]:hidden')
    expect(skeletonSource).toContain('w-[18.125rem]')
    expect(skeletonSource).toContain('max-w-[40%]')
    expect(skeletonSource).toContain('border-(--solus-container-border)')
    expect(skeletonSource).toMatch(
      /treeRows[\s\S]*flex min-h-0 min-w-0 flex-1 flex-col gap-1\.5/,
    )
  })

  test('does not measure width after paint', () => {
    expect(skeletonSource).not.toContain('bind:clientWidth')
  })
})
