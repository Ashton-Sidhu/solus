import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const bootstrapSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/contexts/workspace/session-bootstrap.ts'),
  'utf8',
)
const workspaceSource = readFileSync(
  join(import.meta.dir, '../../src/renderer/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)

describe('restored session hydration retry', () => {
  test('keeps a failed active hydration pending and retries it on selection', () => {
    // WHY: the active session can sit behind a restored draft while its first
    // history read races connection startup. It must remain retryable, and a
    // click on that already-active session must trigger the retry.
    const hydrateStart = bootstrapSource.indexOf('async function hydrateDeferredTab')
    const hydrateEnd = bootstrapSource.indexOf('\n}\n', hydrateStart)
    const hydrateBody = bootstrapSource.slice(hydrateStart, hydrateEnd)
    expect(hydrateBody.indexOf('await hydrateTab(ctx, snapTab)')).toBeLessThan(
      hydrateBody.indexOf('state.pending.delete(tabId)'),
    )
    expect(bootstrapSource).toContain(
      'pending: new Map(persistedTabs.map((snapTab) => [snapTab.tabId, snapTab]))',
    )

    const selectStart = workspaceSource.indexOf('selectTab(tabId: string')
    const selectEnd = workspaceSource.indexOf('\n  }', selectStart)
    expect(workspaceSource.slice(selectStart, selectEnd)).toContain(
      'prioritizeTabHydration(this, tabId)',
    )
  })
})
