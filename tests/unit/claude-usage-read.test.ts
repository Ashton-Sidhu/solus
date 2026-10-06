import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

const realCliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({
  ...realCliEnv,
  warmCliPath: async () => '/fixture/bin',
  findOnPath: () => '/fixture/bin/claude',
}))

const SLASH_REPORT = 'Current session: 43% used · resets Jul 31 at 1am (America/Toronto)'

/** What the stubbed query exposes as its usage method; undefined means an SDK without it. */
let usageMethod: ((opts?: { skipBehaviors?: boolean }) => Promise<unknown>) | undefined
const prompts: unknown[] = []
const aborted: boolean[] = []
const realSdk = await import('@anthropic-ai/claude-agent-sdk')
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: ({ prompt, options }: { prompt: unknown; options: Options }) => {
    prompts.push(prompt)
    const index = aborted.push(false) - 1
    options.abortController?.signal.addEventListener('abort', () => { aborted[index] = true })
    const messages = prompt === '/usage' ? [{ type: 'result', subtype: 'success', result: SLASH_REPORT }] : []
    return Object.assign((async function* () { yield* messages })(), {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usageMethod,
    })
  },
}))
const { ClaudeAgent } = await import('@solus/server/execution/agents/claude/claude-agent')

beforeEach(() => {
  prompts.length = 0
  aborted.length = 0
})

describe('ClaudeAgent.readUsageReport', () => {
  test('reads the usage API without the transcript scan and never runs /usage', async () => {
    let options: unknown
    usageMethod = async (opts) => {
      options = opts
      return {
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 12, resets_at: '2026-07-31T05:00:00Z' }, seven_day: null },
      }
    }
    const usage = await new ClaudeAgent().readUsageReport()
    // The scan of local transcripts took 5+ s on a large history; only limits are needed.
    expect(options).toEqual({ skipBehaviors: true })
    expect(usage).toEqual({
      fiveHour: { usedPercent: 12, resetsAt: Date.parse('2026-07-31T05:00:00Z'), resetsLabel: null },
      weekly: null,
      planType: 'pro',
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toBe('/usage')
    expect(aborted).toEqual([true])
  })

  test('an account without plan limits reads as no data, without the text fallback', async () => {
    usageMethod = async () => ({ subscription_type: null, rate_limits_available: false, rate_limits: null })
    expect(await new ClaudeAgent().readUsageReport()).toBeNull()
    expect(prompts).toHaveLength(1)
  })

  test('falls back to the /usage text when the usage API fails, and closes both processes', async () => {
    usageMethod = async () => { throw new Error('control request timed out') }
    const usage = await new ClaudeAgent().readUsageReport()
    expect(usage?.fiveHour?.usedPercent).toBe(43)
    expect(usage?.planType).toBeNull()
    expect(prompts[1]).toBe('/usage')
    expect(aborted).toEqual([true, true])
  })

  test('falls back to the /usage text on an SDK without the usage API', async () => {
    usageMethod = undefined
    const usage = await new ClaudeAgent().readUsageReport()
    expect(usage?.fiveHour?.usedPercent).toBe(43)
    expect(prompts[1]).toBe('/usage')
  })
})
