import type { AgentId, Plan, PlanDescriptor, PermissionOption, PlanReference, ReasoningEffort, SessionMeta, WorkReference } from '../../../shared/types'
import { MODEL_PROFILES, planKey, encodePathAsFolder } from '../../../shared/types'
import type { ModelProfile } from '../../../shared/types'
import { findOpenTabForSession } from '../../lib/sessionUtils'
import { formatInlineComments, nextMsgId } from './session.utils'
import { track } from '../../lib/analytics'
import type { WorkspaceContext } from './workspace.context.svelte'

// ─── Active plan waiting state ───

/**
 * The viewer is global, so approve/reject must act on the session that owns the
 * plan (via plan.sessionId), not whichever tab is active. Falls back to the
 * active tab for the preview-resume path, which just created/selected it.
 */
function resolvePlanTabId(ctx: WorkspaceContext, plan: Plan): string {
  return findOpenTabForSession(plan.sessionId, ctx.tabs, ctx.sessions, ctx.tabOrder) ?? ctx.activeTabId
}

export function clearPlanWaiting(ctx: WorkspaceContext, sessionId: string): void {
  const planId = ctx.router.params('plan')?.planId
  if (!planId) return
  const plan = ctx.planStore.plans[planId]
  if (plan?.sessionId === sessionId && plan.status !== 'pending') {
    ctx.router.close('plan')
  }
}

export async function openPlanModal(ctx: WorkspaceContext, planId: string, ref?: {
  sessionId?: string
  planToolUseId?: string
  status?: Plan['status']
}, opts: { secondary?: boolean } = {}): Promise<void> {
  let targetPlanId = planId || (ref?.sessionId && ref.planToolUseId ? planKey(ref.sessionId, ref.planToolUseId) : '')
  if (!targetPlanId) return

  // `secondary` forces the plan beside the conversation (the conversation-ref
  // "pop out to side" action); otherwise it takes the focused pane.
  const reveal = (id: string) => {
    ctx.openPlan(id, opts.secondary ? 'aside' : 'focused')
    ctx.isExpanded = true
  }

  const plan = ctx.planStore.plans[targetPlanId]
  if (plan?.content?.trim()) {
    reveal(targetPlanId)
    await ctx.planStore.hydrateAnnotations(targetPlanId)
    return
  }

  const sessionId = ref?.sessionId ?? plan?.sessionId ?? targetPlanId.split('__')[0]
  const planToolUseId = ref?.planToolUseId ?? plan?.planToolUseId ?? targetPlanId.split('__').slice(1).join('__')
  const cwd = plan?.cwd ?? ctx.activeSession?.run.workingDirectory ?? ctx.globalDefaults.workingDirectory
  const projectPath = plan?.projectPath ?? encodePathAsFolder(cwd)
  if (!sessionId || !planToolUseId || !cwd) return

  // Reveal on the id the read will resolve to, so the click lands on the plan
  // surface's skeleton instead of on nothing while the body comes off disk.
  targetPlanId = planKey(sessionId, planToolUseId)
  reveal(targetPlanId)

  try {
    await ctx.planStore.loadFromDisk({
      serverId: ctx.planStore.hostFor?.(targetPlanId) ?? ctx.activeSession?.run.serverId,
      sessionId,
      planToolUseId,
      projectPath,
      cwd,
      status: ref?.status,
      ctx: ctx.ctx,
      provider: ctx.activeSession?.run.provider,
    })
  } catch {}

  // Nothing on disk: retract the surface rather than leave it loading forever
  // — unless the user has already moved it on to something else.
  if (!ctx.planStore.plans[targetPlanId]?.content?.trim() && ctx.router.params('plan')?.planId === targetPlanId) {
    ctx.router.close('plan')
  }
}

export function closePlanModal(ctx: WorkspaceContext): void {
  ctx.router.close('plan')
}

export function requestConversationScrollToBottom(tabId: string): void {
  window.dispatchEvent(new CustomEvent('solus:scroll-conversation-bottom', { detail: { tabId } }))
}

// ─── Plan approval / rejection ───

export interface ApprovePlanOptions {
  /** Pass provider + modelId together, and only when they differ from the
   *  session's current choice — the pair triggers a provider/model switch. */
  provider?: AgentId
  modelId?: string
  reasoningEffort?: ReasoningEffort
  generalComment?: string
  useWorktree?: boolean
  /** Defaults to true to preserve the existing approval behavior. */
  startNewSession?: boolean
  /** Extra references from the approval note's editor. */
  planRefs?: PlanReference[]
  workRefs?: WorkReference[]
}

export async function approvePlanWithModel(
  ctx: WorkspaceContext,
  planId: string,
  mode: 'ask' | 'auto',
  opts: ApprovePlanOptions = {},
): Promise<void> {
  const wasPreview = !!ctx.planStore.previewDescriptor
  if (wasPreview) await resumeFromPreview(ctx)

  const plan = ctx.planStore.plans[planId]
  if (!plan) return

  const tabId = resolvePlanTabId(ctx, plan)
  const session = ctx.sessionFor(tabId)
  const tab = ctx.tabs[tabId]
  if (!session || !tab) return

  ctx.planStore.setStatus(planId, 'accepted')
  clearPlanWaiting(ctx, plan.sessionId)

  const isActive = session.status === 'running' || session.status === 'connecting'
    || session.status === 'awaiting_plan' || session.status === 'awaiting_input'
  if (isActive) {
    await ctx.apiFor(tabId).stopSession(ctx.ctxFor(tabId).session.sessionId)
    // The planning run ends because the work is moving to the implementation
    // session, not because the reader stopped it — the approval note and the
    // session boundary below already tell that story. Writing a stop notice here
    // put "Stopped by you" across every accepted plan.
    ctx.interruptTabSession(tabId, { notice: false })
  }

  const providerChanged = !!opts.provider && opts.provider !== session.run.provider
  if (providerChanged) {
    await ctx.switchActiveAgent(opts.provider!, tabId)
    // switchActiveAgent owns handoff errors and leaves the original provider in
    // place. Do not accidentally submit the approved work to that provider.
    if (session.run.provider !== opts.provider) {
      ctx.planStore.setStatus(planId, 'pending')
      return
    }
  }

  // A cross-provider handoff already detaches the old provider session and
  // preserves it as lineage for the next run. Resetting here would erase that
  // pending handoff. Same-provider model changes still require a fresh session.
  const shouldStartNewSession = !providerChanged
    && (opts.startNewSession !== false || !!(opts.provider && opts.modelId))
  if (shouldStartNewSession) {
    ctx.apiFor(tabId).resetSession(ctx.ctxFor(tabId))
    session.agentSessionId = null
    // The implementation run starts on a fresh agent session carrying only the
    // plan, so everything above this point is another session's context. Say so
    // — otherwise the reset is indistinguishable from the thread forgetting.
    session.messages.push({
      id: nextMsgId(),
      role: 'system',
      content: '',
      timestamp: Date.now(),
      newSessionForPlanId: planId,
    })
  }

  if (opts.provider && opts.modelId) {
    if (!providerChanged) {
      session.run.provider = opts.provider
      ctx.config.followActiveSessionAgent(opts.provider)
    }
    const profile = MODEL_PROFILES[opts.provider as keyof typeof MODEL_PROFILES]?.[opts.modelId]
    session.run.modelConfig = { modelId: opts.modelId, reasoningEffort: opts.reasoningEffort ?? (profile as ModelProfile)?.defaultReasoningEffort ?? 'high', contextWindow: (profile as ModelProfile)?.defaultContextWindow ?? null, fastMode: false }
    session.sessionModel = null
  } else if (opts.reasoningEffort) {
    session.run.modelConfig.reasoningEffort = opts.reasoningEffort
  }
  session.run.permissionMode = mode

  if (wasPreview && opts.useWorktree && !session.run.gitContext) {
    await ctx.environment.refreshEnvironment(ctx, { sourceId: tabId, cwd: plan.cwd })
  }

  if (opts.useWorktree !== undefined) {
    session.run.worktree = opts.useWorktree ? { baseBranch: session.run.gitContext?.targetBranch ?? null } : null
  }

  const params = new URLSearchParams({
    planId,
    sessionId: plan.sessionId,
    planToolUseId: plan.planToolUseId,
    status: 'accepted',
  })
  const safeTitle = plan.title.replace(/[\[\]]/g, '\\$&')
  const planLink = `[${safeTitle}](plan://ref?${params})`

  let message = `Implement this plan: ${planLink}`
  const hasInline = plan.comments.length > 0
  if (opts.generalComment || hasInline) {
    const parts: string[] = []
    if (opts.generalComment) parts.push(opts.generalComment)
    if (hasInline) parts.push(`Inline comments:\n${formatInlineComments(plan.comments)}`)
    message += `\n\nNotes:\n${parts.join('\n\n')}`
  }

  const prompt = ctx.sessionFor(tab.id)?.prompt
  if (!prompt) return
  prompt.planRefs = [
    { planId, sessionId: plan.sessionId, planToolUseId: plan.planToolUseId, title: plan.title, status: 'accepted' },
    ...(opts.planRefs ?? []).filter((r) => r.planId !== planId),
  ]
  prompt.workRefs = opts.workRefs ? [...opts.workRefs] : []
  ctx.sendMessage(message)
  track('plan_approved', { mode })
  requestConversationScrollToBottom(tabId)
}

export async function rejectPlan(ctx: WorkspaceContext, planId: string, comment?: string): Promise<void> {
  if (ctx.planStore.previewDescriptor) await resumeFromPreview(ctx)
  const plan = ctx.planStore.plans[planId]
  if (!plan) return
  const tabId = resolvePlanTabId(ctx, plan)
  const session = ctx.sessionFor(tabId)
  // A run holding a plan up for review reports `awaiting_plan`, never 'running' —
  // gating on 'running' alone sent every revise down the abort path, which kills
  // the turn, prints "Stopped by you", and folds the whole planning turn away.
  // Answering the permission with its deny option leaves the run alive, so the
  // revise note steers into the same turn with all of its context.
  const sessionIsLive = !!plan.questionId && !!plan.options?.length
    && (session?.status === 'running' || session?.status === 'awaiting_plan' || session?.status === 'awaiting_input')

  if (sessionIsLive) {
    const denyOption = plan.options!.find((o: PermissionOption) => o.kind === 'deny') ?? plan.options![plan.options!.length - 1]
    // Awaited so the deny lands before the note, otherwise the note can steer
    // into a turn that is still blocked on the unanswered plan permission.
    await ctx.apiFor(tabId).respondPermission(ctx.ctxFor(tabId), plan.questionId!, denyOption.id)
  } else {
    // Only a run that was actually cancelled was stopped. Revising a plan whose
    // run has already exited cancels nothing, so it must not claim otherwise.
    const cancelled = await ctx.apiFor(tabId).stopSession(ctx.ctxFor(tabId).session.sessionId)
    ctx.interruptTabSession(tabId, { notice: cancelled })
  }

  ctx.planStore.setStatus(planId, 'rejected')
  track('plan_rejected', { has_comment: !!comment || plan.comments.length > 0 })
  clearPlanWaiting(ctx, plan.sessionId)

  const inlineComments = plan.comments
  if (comment || inlineComments.length > 0) {
    ctx.setPermissionMode('plan', tabId)
    const parts: string[] = []
    if (comment) parts.push(comment)
    if (inlineComments.length > 0) parts.push(`Inline comments:\n${formatInlineComments(inlineComments)}`)
    ctx.sendMessage(`Please revise the plan with these comments:\n\n${parts.join('\n\n')}`, undefined, tabId)
  }

  requestConversationScrollToBottom(tabId)
}

// ─── Plan navigation ───

async function loadOrFindTab(ctx: WorkspaceContext, sessionId: string, cwd: string, projectPath: string, provider?: AgentId, title?: string, serverId?: string): Promise<string> {
  const existing = findOpenTabForSession(sessionId, ctx.tabs, ctx.sessions, ctx.tabOrder, provider, serverId)
  if (existing) {
    ctx.selectTab(existing)
    return existing
  }
  const meta: SessionMeta = {
    sessionId,
    provider: provider ?? ctx.settings.activeAgent as AgentId,
    cwd,
    projectPath,
    serverId,
    slug: title ?? null,
    firstMessage: null,
    lastTimestamp: '',
    size: 0,
  }
  return await ctx.resumeSession(meta)
}

/** Pull one descriptor's plan into the store. Readers that only need the plan
 *  itself — the Workspace peek — call this; opening a plan goes through
 *  `loadDescriptorPlan`, which also warms the sibling revisions. */
export async function loadPlanContent(ctx: WorkspaceContext, d: PlanDescriptor): Promise<string> {
  return await ctx.planStore.loadFromDisk({
    serverId: d.serverId,
    sessionId: d.sessionId,
    planToolUseId: d.planToolUseId,
    projectPath: d.projectPath,
    cwd: d.cwd,
    timestamp: d.timestamp,
    filePath: d.planFilePath,
    title: d.title,
    status: d.status,
    bookmarked: d.bookmarked,
    bookmarkedAt: d.bookmarkedAt,
    ctx: ctx.ctx,
    provider: d.provider,
  })
}

async function loadDescriptorPlan(ctx: WorkspaceContext, d: PlanDescriptor): Promise<string> {
  const id = await loadPlanContent(ctx, d)

  // Load sibling revisions in the background so the revision dropdown works.
  for (const rev of d.revisions) {
    const revId = planKey(d.sessionId, rev.planToolUseId)
    if (ctx.planStore.plans[revId]) continue
    void ctx.planStore.loadFromDisk({
      serverId: d.serverId,
      sessionId: d.sessionId,
      planToolUseId: rev.planToolUseId,
      projectPath: d.projectPath,
      cwd: d.cwd,
      timestamp: rev.timestamp,
      filePath: rev.planFilePath,
      title: rev.title,
      status: rev.status,
      ctx: ctx.ctx,
      provider: d.provider,
    })
  }

  return id
}

export async function openPlanFromDescriptor(ctx: WorkspaceContext, d: PlanDescriptor): Promise<void> {
  const planId = planKey(d.sessionId, d.planToolUseId)
  const existing = findOpenTabForSession(d.sessionId, ctx.tabs, ctx.sessions, ctx.tabOrder, d.provider, d.serverId)
  if (existing) {
    ctx.router.close('folio')
    ctx.selectTab(existing)
    ctx.openPlan(planId)
    ctx.isExpanded = true
    await loadDescriptorPlan(ctx, d)
    // Reveal (already done) plus annotation hydration, and the retract if the
    // descriptor pointed at a plan that is no longer on disk.
    openPlanModal(ctx, planId)
    return
  }

  // The gallery card gives way to the plan surface's skeleton straight away —
  // the descriptor already names the plan, only its body has to come off disk.
  ctx.router.close('folio')
  ctx.planStore.previewDescriptor = d
  ctx.openPlan(planId)

  await loadDescriptorPlan(ctx, d)

  if (ctx.router.params('plan')?.planId !== planId) return
  if (ctx.planStore.plans[planId]?.content?.trim()) ctx.planStore.openPreview(planId)
  else closePlanPreview(ctx)
}

export async function resumeFromPreview(ctx: WorkspaceContext): Promise<void> {
  const d = ctx.planStore.previewDescriptor
  ctx.planStore.dismissPreview()
  if (d) {
    await loadOrFindTab(ctx, d.sessionId, d.cwd, d.projectPath, d.provider, d.title, d.serverId)
  }
}

export function closePlanPreview(ctx: WorkspaceContext): void {
  ctx.planStore.dismissPreview()
  ctx.openFolio()
}

export async function resumeSessionFromDescriptor(ctx: WorkspaceContext, d: PlanDescriptor): Promise<void> {
  ctx.planStore.dismissPreview()
  await loadDescriptorPlan(ctx, d)
  const tabId = await loadOrFindTab(ctx, d.sessionId, d.cwd, d.projectPath, d.provider, d.title, d.serverId)
  ctx.router.close('folio')
  closePlanModal(ctx)
  setTimeout(() => requestConversationScrollToBottom(tabId), 50)
}
