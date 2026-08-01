import { describe, expect, test } from 'bun:test'
import type { Plan } from '../../src/shared/types'
import { openPlanModal } from '../../src/renderer/contexts/workspace/session-plan-operations'

/**
 * Opening a plan reads its body off disk. The surface has to be revealed on the
 * plan's id *before* that read resolves — otherwise the click does nothing
 * visible until the file lands, which is the gap the skeleton exists to fill.
 * The flip side is that an empty read must retract the surface, or the
 * placeholder becomes permanent.
 */
function openContext(diskContent: string | null) {
  const plans: Record<string, Plan> = {}
  const opened: string[] = []
  let closes = 0
  let resolveRead: () => void = () => {}
  const readStarted = new Promise<void>((resolve) => { resolveRead = resolve })

  const ctx = {
    activeTabId: 'tab-1',
    activeSession: { workingDirectory: '/repo', provider: 'claude-code' },
    globalDefaults: { workingDirectory: '/repo' },
    ctx: undefined,
    isExpanded: false,
    planStore: {
      plans,
      hydrateAnnotations: async () => {},
      loadFromDisk: async (opts: { sessionId: string; planToolUseId: string }) => {
        const id = `${opts.sessionId}__${opts.planToolUseId}`
        resolveRead()
        // Yield, so the assertion on "already revealed" runs mid-read.
        await Promise.resolve()
        if (diskContent !== null) plans[id] = { id, content: diskContent } as Plan
        return id
      },
    },
    panes: {
      get activePlanId() { return opened.at(-1) ?? null },
      openPlan: (id: string) => { opened.push(id) },
      close: () => { closes++; opened.pop() },
    },
  }

  return {
    ctx: ctx as unknown as Parameters<typeof openPlanModal>[0],
    opened,
    readStarted,
    closeCount: () => closes,
  }
}

describe('openPlanModal', () => {
  test('reveals the plan surface before the disk read resolves', async () => {
    const { ctx, opened, readStarted } = openContext('# Plan\n\nBody.')

    const opening = openPlanModal(ctx, 'agent-session-1__plan-tool-1')
    await readStarted

    expect(opened).toEqual(['agent-session-1__plan-tool-1'])
    await opening
  })

  test('keeps the surface open once the plan has content', async () => {
    const { ctx, opened, closeCount } = openContext('# Plan\n\nBody.')

    await openPlanModal(ctx, 'agent-session-1__plan-tool-1')

    expect(opened).toEqual(['agent-session-1__plan-tool-1'])
    expect(closeCount()).toBe(0)
  })

  test('retracts the surface when the plan is not on disk', async () => {
    const { ctx, opened, closeCount } = openContext(null)

    await openPlanModal(ctx, 'agent-session-1__plan-tool-1')

    expect(closeCount()).toBe(1)
    expect(opened).toEqual([])
  })
})
