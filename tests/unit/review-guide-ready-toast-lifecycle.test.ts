import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appCoreSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/contexts/app/app-core.ts'),
  'utf8',
)

describe('review guide ready toast lifecycle', () => {
  test('removes the shared store listener when the app root is destroyed', () => {
    // WHY: the app root can remount during development. A leaked listener emits
    // one duplicate completion toast for every previous app instance.
    expect(appCoreSource).toContain(
      'const unsubscribeReviewGuideReady = reviewGuideStore.onReady(',
    )
    expect(appCoreSource).toContain('onDestroy(unsubscribeReviewGuideReady)')
  })
})
