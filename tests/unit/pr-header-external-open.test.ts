import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const reviewPane = readFileSync(
  join(root, 'packages/workspace-ui/src/components/pr-review/PrReviewPane.svelte'),
  'utf8',
)

describe('pull request header external open', () => {
  test('routes both header shapes through the client external opener', () => {
    // WHY: "Open pull request page" means the provider page in the system
    // browser. It must not promote the embedded panel to another Solus route.
    expect(reviewPane).toContain('if (prUrl) void localApi.openExternal(prUrl)')
    expect(reviewPane.match(/onOpenPage=\{prUrl \? openPr : undefined\}/g)).toHaveLength(2)
    expect(reviewPane).not.toContain('onOpenPage={onOpenRoute}')
  })
})
