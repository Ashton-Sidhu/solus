import { describe, expect, test } from 'bun:test'
import type { AgentToolContext } from '@solus/server/agents/tools/agent-tool'
import {
  configureReviewRequestTool,
  requestReviewGuideAgentTool,
} from '@solus/server/review/review-request-tool'

describe('request_review_guide tool lifecycle', () => {
  test('keeps the session skeleton open until the shared hidden author finishes', async () => {
    let finishGeneration!: () => void
    const generation = new Promise<void>((resolve) => {
      finishGeneration = resolve
    })
    configureReviewRequestTool({
      generate: async () => {
        await generation
        return {
          key: 'session-provider-session',
          persisted: true,
          guide: {
            version: 1,
            key: 'session-provider-session',
            headSha: 'head-a',
            baseSha: 'HEAD',
            changeFingerprint: 'patch-a',
            title: 'Review guide',
            summary: 'Ready',
            sections: [],
          },
        }
      },
    })
    const context: AgentToolContext = {
      provider: 'codex',
      cwd: '/repo',
      sessionId: () => 'provider-session',
      solusSessionId: () => 'solus-session',
      parentToolUseId: () => undefined,
      abortSignal: new AbortController().signal,
      emit: () => {},
    }

    let settled = false
    const result = requestReviewGuideAgentTool
      .execute({ target: { kind: 'session' } }, context)
      .then((value) => {
        settled = true
        return value
      })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishGeneration()
    expect(await result).toEqual({
      ok: true,
      text: JSON.stringify({
        target: { kind: 'session' },
        key: 'session-provider-session',
        changeFingerprint: 'patch-a',
      }),
    })
  })
})
