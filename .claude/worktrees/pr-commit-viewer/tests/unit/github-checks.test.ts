import { describe, expect, test } from 'bun:test'
import {
  normalizePullRequestChecks,
  type GqlChecksPullRequest,
} from '../../src/main/providers/github/checks'

function pullRequest(
  nodes: NonNullable<NonNullable<GqlChecksPullRequest['commits']['nodes'][number]>['commit']['statusCheckRollup']>['contexts']['nodes'],
  options: { rollup?: boolean; totalCount?: number } = {},
): GqlChecksPullRequest {
  return {
    number: 42,
    headRefOid: 'head-42',
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: options.rollup === false ? null : {
            state: 'SUCCESS',
            contexts: { totalCount: options.totalCount ?? nodes.length, nodes },
          },
        },
      }],
    },
  }
}

const requiredRun = {
  __typename: 'CheckRun' as const,
  databaseId: 101,
  name: 'unit',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  detailsUrl: 'https://example.test/unit',
  startedAt: '2026-07-15T10:00:00Z',
  completedAt: '2026-07-15T10:01:00Z',
  isRequired: true,
  checkSuite: { app: { name: 'GitHub Actions' } },
}

describe('GitHub PR check normalization', () => {
  test('merges CheckRun and StatusContext nodes while preserving requiredness', () => {
    const summary = normalizePullRequestChecks(pullRequest([
      requiredRun,
      {
        __typename: 'StatusContext',
        context: 'deploy-preview',
        state: 'FAILURE',
        targetUrl: 'https://example.test/preview',
        description: 'Preview failed',
        createdAt: '2026-07-15T10:02:00Z',
        isRequired: false,
      },
    ]))

    expect(summary.required).toEqual([{
      id: '101',
      name: 'unit',
      conclusion: 'success',
      inFlight: false,
      detailsUrl: 'https://example.test/unit',
      appName: 'GitHub Actions',
      startedAt: '2026-07-15T10:00:00Z',
      completedAt: '2026-07-15T10:01:00Z',
    }])
    expect(summary.optional[0]).toMatchObject({
      id: 'deploy-preview',
      name: 'deploy-preview',
      conclusion: 'failure',
      inFlight: false,
      appName: null,
    })
  })

  test("a null rollup means 'none', not passing and not a load error", () => {
    expect(normalizePullRequestChecks(pullRequest([], { rollup: false }))).toEqual({
      state: 'none',
      required: [],
      optional: [],
      headSha: 'head-42',
      inFlight: false,
    })
  })

  test('optional failures never gate a merge', () => {
    const summary = normalizePullRequestChecks(pullRequest([
      requiredRun,
      {
        __typename: 'StatusContext',
        context: 'preview',
        state: 'ERROR',
        targetUrl: null,
        description: null,
        createdAt: '2026-07-15T10:02:00Z',
        isRequired: false,
      },
    ]))

    expect(summary.state).toBe('passing')
    expect(summary.optional[0].conclusion).toBe('failure')
  })

  test('required non-terminal checks drive both pending state and poll cadence', () => {
    const summary = normalizePullRequestChecks(pullRequest([
      { ...requiredRun, status: 'IN_PROGRESS', conclusion: null },
      {
        __typename: 'StatusContext',
        context: 'legacy-ci',
        state: 'PENDING',
        targetUrl: null,
        description: null,
        createdAt: '2026-07-15T10:02:00Z',
        isRequired: false,
      },
    ]))

    expect(summary.state).toBe('pending')
    expect(summary.inFlight).toBe(true)
    expect(summary.required[0]).toMatchObject({ conclusion: null, inFlight: true })
    expect(summary.optional[0]).toMatchObject({ conclusion: null, inFlight: true })
  })
})
