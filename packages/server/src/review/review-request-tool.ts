import { z } from 'zod'
import type { AgentId, IpcContext } from '@solus/contracts/types'
import type { ReviewGuideReference } from '@solus/contracts/review'
import type { AgentTool, AgentToolContext } from '../agents/tools/agent-tool'
import { getHostConfig } from '../server/settings'
import type { GeneratedGuide } from './guide-producer'

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('working-tree') }),
  z.object({ kind: z.literal('session'), sessionId: z.string().optional() }),
  z.object({ kind: z.literal('branch'), targetBranch: z.string().optional() }),
  z.object({
    kind: z.literal('pr'),
    host: z.string(),
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive(),
    url: z.string().url().optional(),
    baseSha: z.string().optional(),
    headSha: z.string().optional(),
  }),
])

type ReviewRequestRuntime = {
  generate: (
    ctx: IpcContext,
    target: ReviewGuideReference['target'],
    agent: AgentId,
  ) => Promise<GeneratedGuide | null>
  preparePr?: (
    ctx: IpcContext,
    target: Extract<ReviewGuideReference['target'], { kind: 'pr' }>,
  ) => Promise<{ ctx: IpcContext; target: Extract<ReviewGuideReference['target'], { kind: 'pr' }> }>
}

let runtime: ReviewRequestRuntime | null = null

/** The server composition root owns the producer and event publisher. The
 * normal-session tool remains a stable object for both provider adapters. */
export function configureReviewRequestTool(value: ReviewRequestRuntime): void {
  runtime = value
}

function requestContext(context: AgentToolContext): IpcContext {
  const providerSessionId = context.sessionId() ?? null
  return {
    session: {
      sessionId: context.solusSessionId() ?? providerSessionId ?? '',
      provider: context.provider,
      agentSessionId: providerSessionId,
      status: 'running',
      workingDirectory: context.cwd,
      projectPath: context.cwd,
      additionalDirs: [],
      preferredModel: null,
      reasoningEffort: 'medium',
      contextWindow: null,
      fastMode: false,
      permissionMode: 'plan',
      gitContext: null,
      worktreeBaseBranch: null,
      sessionChangedFiles: [],
      readOnlyReason: null,
      latestCheckpointId: null,
    },
    window: { viewMode: 'editor' },
    settings: {
      themeMode: 'system',
      isDark: false,
      soundEnabled: false,
      voiceModeEnabled: false,
      vadSilenceMs: 800,
      defaultEditor: null,
      fallbackTerminal: null,
      activeAgent: context.provider,
      reviewAgent: context.provider,
      reviewModel: null,
      reviewReasoning: null,
      stackedPrsEnabled: false,
      reviewWarmingEnabled: false,
      rateLimitBehavior: 'ask',
      fontFamily: 'inter',
      fontSize: 14,
      codeFontFamily: 'sf-mono',
      codeFontSize: 13,
      // A background review is still the user's turn, so it carries the app-wide
      // instructions they wrote in Settings.
      extraInstructions: getHostConfig().config.extraInstructions,
      modelInstructions: getHostConfig().config.modelInstructions,
    },
    statusBar: {
      workingDirectory: context.cwd,
      activeAgent: context.provider,
      permissionMode: 'plan',
      model: '',
      reasoningEffort: 'medium',
      defaultReasoningEffort: 'medium',
      reasoningLevels: ['medium'],
      supportsFastMode: false,
      fastMode: false,
      contextWindows: [],
    },
  }
}

export const requestReviewGuideAgentTool: AgentTool<{ target: typeof targetSchema }> = {
  name: 'request_review_guide',
  description: 'Generate one Solus review guide for the typed target and return its durable conversation-card reference. The call stays open while the hidden author works. Do not inspect or author the diff in this visible session.',
  inputFields: {
    target: targetSchema.describe('The exact review scope selected by the command or host.'),
  },
  requiresApproval: false,
  async execute(input, context) {
    if (!runtime) return { ok: false, text: 'Review guide generation is unavailable.' }
    let ctx = requestContext(context)
    let target = input.target
    if (target.kind === 'pr' && runtime.preparePr) {
      const prepared = await runtime.preparePr(ctx, target)
      ctx = prepared.ctx
      target = prepared.target
    }
    const generated = await runtime.generate(ctx, target, context.provider)
    if (!generated) return { ok: false, text: 'No Git change is available to review.' }
    const reference: ReviewGuideReference = {
      target,
      key: generated.key,
      changeFingerprint: generated.guide.changeFingerprint,
    }
    return { ok: true, text: JSON.stringify(reference) }
  },
}
