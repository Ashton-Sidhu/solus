import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const bootstrapSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/session-bootstrap.ts'),
  'utf8',
)
const workspaceSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts'),
  'utf8',
)

describe('restored session hydration retry', () => {
  test('keeps a failed active hydration pending and retries it on selection', () => {
    // WHY: the active session can sit behind a restored draft while its first
    // history read races connection startup. It must remain retryable, and a
    // click on that already-active session must trigger the retry.
    const hydrateStart = bootstrapSource.indexOf('async function hydrateRestoredTab')
    const hydrateEnd = bootstrapSource.indexOf('\n}\n', hydrateStart)
    const hydrateBody = bootstrapSource.slice(hydrateStart, hydrateEnd)
    const loadIndex = hydrateBody.indexOf('const hydration = hydrateTab(ctx, snapTab)')
    const completionIndex = hydrateBody.indexOf('state.pending.delete(tabId)')
    expect(loadIndex).toBeGreaterThanOrEqual(0)
    expect(completionIndex).toBeGreaterThan(loadIndex)
    expect(bootstrapSource).toContain(
      'pending: new Map(snapshot.tabs.map((snapTab) => [snapTab.tabId, snapTab]))',
    )

    const selectStart = workspaceSource.indexOf('selectTab(tabId: string')
    const selectEnd = workspaceSource.indexOf('\n  }', selectStart)
    expect(workspaceSource.slice(selectStart, selectEnd)).toContain(
      'prioritizeTabHydration(this, tabId)',
    )
  })

  test('loads durable history before the restored session starts receiving live events', () => {
    // WHY: a watch can deliver a live user or assistant event while loadSession
    // is in flight. If that event makes the history guard reject a successful
    // response, refresh leaves the durable session with no transcript.
    const hydrateStart = bootstrapSource.indexOf('async function hydrateTab')
    const hydrateBody = bootstrapSource.slice(hydrateStart)

    expect(hydrateBody.indexOf('loadRestoredSessionTranscript')).toBeLessThan(
      hydrateBody.indexOf('await api.watchSession'),
    )
    expect(hydrateBody).toContain('return s === session && s.agentSessionId === snapTab.agentSessionId')
  })

  test('uses one restored-tab operation for boot, selection, and reconnect', () => {
    // WHY: separate attached/deferred/reconnect paths drifted into different
    // ordering and retry rules. Every entry point must share one pending tab and
    // one in-flight promise so failures remain retryable without duplicate reads.
    expect(bootstrapSource).not.toContain('const attached = new WeakSet')
    expect(bootstrapSource).not.toContain('DeferredHydrationState')
    expect(bootstrapSource).toContain('const restorations = new WeakMap<WorkspaceContext, RestoredWorkspaceState>()')
    expect(bootstrapSource).toContain('running: Map<string, Promise<void>>')
    expect(bootstrapSource).toContain(
      'if (ctx.activeTabId) await hydrateRestoredTab(ctx, state, ctx.activeTabId)',
    )
    expect(bootstrapSource).toContain(
      'await hydrateRestoredTab(ctx, restoredState, tabId).catch(() => null)',
    )
  })
})
