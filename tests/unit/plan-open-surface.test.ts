import { describe, expect, test } from 'bun:test'
import type { Plan } from '@solus/contracts/types'
import { openPlanModal } from '@solus/workspace-ui/contexts/workspace/session-plan-operations'

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
    activeSession: { run: { workingDirectory: '/repo', provider: 'claude-code' } },
    globalDefaults: { workingDirectory: '/repo' },
    ctx: undefined,
    isExpanded: false,
    planStore: {
      plans,
      cachedDescriptors: [],
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
    router: {
      params: (name: string) => (name === 'plan' ? { planId: opened.at(-1) ?? null } : null),
      close: () => { closes++; opened.pop() },
    },
    openPlan: (id: string) => { opened.push(id) },
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

  test('loads a referenced plan from the host and provider that listed it', async () => {
    // WHY: a plan chip can refer to a Claude plan while the active composer is
    // Codex. Loading through the active run returns no body and leaves the plan
    // surface on its skeleton.
    let loadOptions: {
      serverId?: string
      provider?: string | null
      projectPath: string
      cwd: string
    } | null = null
    const { ctx } = openContext('# Plan\n\nBody.')
    ctx.planStore.cachedDescriptors = [{
      serverId: 'plan-host',
      provider: 'claude-code',
      sessionId: 'agent-session-1',
      planToolUseId: 'plan-tool-1',
      projectPath: '-remote-repo',
      cwd: '/remote/repo',
      timestamp: 1,
      title: 'Plan',
      excerpt: '',
      status: 'pending',
      commentCount: 0,
      bookmarked: false,
      revisions: [],
    }]
    ctx.planStore.loadFromDisk = async (opts) => {
      loadOptions = opts
      const id = `${opts.sessionId}__${opts.planToolUseId}`
      ctx.planStore.plans[id] = { id, content: '# Plan\n\nBody.' } as Plan
      return id
    }

    await openPlanModal(ctx, 'agent-session-1__plan-tool-1')

    expect(loadOptions).toMatchObject({
      serverId: 'plan-host',
      provider: 'claude-code',
      projectPath: '-remote-repo',
      cwd: '/remote/repo',
    })
  })
})
