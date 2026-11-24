import { z } from 'zod'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import type { ReviewGuide, ReviewGuideStatusEvent } from '@solus/contracts/review'
import type { IpcContext, SessionCtx } from '@solus/contracts/types'
import { actorFor } from '../../../admission/actor'
import { recordScopeOf } from '../../../admission/principal'
import { assertToolMay } from '../../../admission/workspace-tool-authority'
import { getSessionRecord } from '../../../data/sessions/session-records'
import { LOCAL_ORGANIZATION_ID } from '../../../host/host-category'
import type { ReviewGuideJobs } from '../../../review/guide-jobs'
import { requestPrGuides } from '../../../review/guide-warmer'
import { readPrGuide } from '../../../review/pr-guide-store'
import type { SessionRuntime } from '../../session-runtime'
import type { AgentDispatcher } from '../agent-runner'
import { environmentFields, pullRequestTool, targetFields, targetNumber, type ToolSession } from './pull-request-tools'

/** What the PR guide tools reach on this host, set once at server start. */
export interface PullRequestGuideToolHost {
  /** The one owner of guide runs, which the `prGenerateGuides` RPC also uses. */
  guides: ReviewGuideJobs
  dispatcher: AgentDispatcher & Pick<SessionRuntime, 'seatForTurn'>
  /** False on a host that runs no agents: PR guides are off there. */
  servesExecution(): boolean
  /** The project folder of a session's run. A PR guide belongs to the project, as on the PR page. */
  projectOf(sessionId: string): string | undefined
}

let host: PullRequestGuideToolHost | undefined
export function installPullRequestGuideToolHost(next: PullRequestGuideToolHost): void {
  host = next
}

function guideHost(): PullRequestGuideToolHost {
  if (!host) throw new Error('Review guides are not available on this host.')
  return host
}

/**
 * The session part of a guide request, as the PR page sends it: the project,
 * with no checkout of its own. A guide is about the pull request, not about
 * this session, so the context names no session.
 */
async function guideSession(session: ToolSession): Promise<SessionCtx> {
  const project = guideHost().projectOf(session.sessionId) ?? session.cwd
  const record = await getSessionRecord(recordScopeOf(session.principal), session.sessionId)
  return {
    sessionId: '', provider: null, agentSessionId: null, status: 'idle',
    workingDirectory: project, projectPath: project, codebaseId: null,
    preferredModel: null, reasoningEffort: 'medium', contextWindow: null, fastMode: false, permissionMode: 'supervised',
    gitContext: null, worktreeBaseBranch: null, worktreeRepositories: null, readOnlyReason: null,
    organizationId: record?.organizationId ?? LOCAL_ORGANIZATION_ID,
  }
}

/**
 * A full guide request context. A guide run reads the review choices from the
 * host's copy of the person's preferences, not from the context, and it reads
 * no status bar.
 */
function guideContext(session: SessionCtx): IpcContext {
  return {
    session,
    statusBar: {
      workingDirectory: session.workingDirectory, activeAgent: DEFAULT_EXECUTION_PREFERENCES.reviewAgent, permissionMode: session.permissionMode,
      model: '', reasoningEffort: session.reasoningEffort, defaultReasoningEffort: session.reasoningEffort,
      reasoningLevels: [], supportsFastMode: false, fastMode: false, contextWindows: [],
    },
  }
}

/** A run's state as the agent reads it. */
function runState(event: ReviewGuideStatusEvent) {
  const { status, headSha, baseSha, step, error, generatedAt } = event
  return { status, headSha, baseSha: baseSha ?? null, step: step ?? null, error: error ?? null, generatedAt: generatedAt ?? null }
}

/** The guide without its hunks: the diff is long, and `pull_request_read` with `include: ["diff"]` reads it. */
function guideBody(guide: ReviewGuide) {
  return {
    title: guide.title, summary: guide.summary, headSha: guide.headSha, baseSha: guide.baseSha, generatedAt: guide.generatedAt ?? null,
    sections: [...guide.sections].sort((a, b) => a.order - b.order).map((section) => ({
      title: section.title, significance: section.significance, explanation: section.explanation,
      attention: section.attention ?? null,
      files: section.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    })),
  }
}

const guideRead = pullRequestTool(
  'pull_request_guide_read',
  'Read the stored review guide of a PR and the state of its run. `guide` is null when there is no guide. This tool never starts a run.',
  targetFields, false, async (input, session) => {
    await assertToolMay('readGuide')
    const number = await targetNumber(session, input)
    const target = { kind: 'pr' as const, ...session.repo, number }
    const [guide, run] = await Promise.all([
      readPrGuide(target),
      guideHost().guides.status({ session: await guideSession(session) }, { target }),
    ])
    return {
      repository: `${session.repo.owner}/${session.repo.repo}`, number,
      guide: guide ? guideBody(guide) : null,
      run: run ? runState(run) : null,
    }
  },
)

const guideWrite = pullRequestTool(
  'pull_request_guide_write',
  'Write review guides for 1 to 20 PRs of this repository: the guide that the PR page shows. The tool returns when the runs start. Each run takes some minutes in a checkout that Solus manages. A PR whose guide is being written joins that run. Read the result with pull_request_guide_read. The tool fails on a host that does not run agents. Each run uses the review agent and model in the settings of the person this session works for.',
  { ...environmentFields, numbers: z.array(z.number().int().positive()).min(1).max(20).describe('PR numbers in this repository.') },
  false, async (input, session) => {
    await assertToolMay('prGenerateGuides')
    const { guides, dispatcher, servesExecution } = guideHost()
    if (!servesExecution()) throw new Error('Review guides are off on this host: it does not run agents. Use a session on a host that does.')
    const actor = actorFor(session.principal)
    const starts = await requestPrGuides({
      dispatcher,
      // Guides run on the requester's own provider login, as their turns do.
      seatFor: (agent) => dispatcher.seatForTurn(actor, agent),
      ctx: guideContext(await guideSession(session)),
      repo: session.repo,
      guides,
    }, input.numbers)
    return {
      repository: `${session.repo.owner}/${session.repo.repo}`,
      runs: starts.map((start) => 'error' in start ? start : { number: start.number, joined: start.joined, ...runState(start.status) }),
    }
  },
)

export const pullRequestGuideTools = { guideRead, guideWrite }
