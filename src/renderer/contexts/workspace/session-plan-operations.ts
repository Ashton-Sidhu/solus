import type { AgentId, Plan, PlanDescriptor, PermissionOption, PlanReference, ReasoningEffort, SessionMeta, WorkReference } from '../../../shared/types'
import { MODEL_PROFILES, planKey, encodePathAsFolder } from '../../../shared/types'
import type { ModelProfile } from '../../../shared/types'
import { findOpenTabForSession } from '../../lib/sessionUtils'
import { formatInlineComments } from './session.utils'
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
  const planId = ctx.panes.activePlanId
  if (!planId) return
  const plan = ctx.planStore.plans[planId]
  if (plan?.sessionId === sessionId && plan.status !== 'pending') {
    ctx.panes.close()
  }
}

export async function openPlanModal(ctx: WorkspaceContext, planId: string, ref?: {
  sessionId?: string
  planToolUseId?: string
  status?: Plan['status']
}, opts: { secondary?: boolean } = {}): Promise<void> {
  let targetPlanId = planId || (ref?.sessionId && ref.planToolUseId ? planKey(ref.sessionId, ref.planToolUseId) : '')
  if (!targetPlanId) return

  let plan = ctx.planStore.plans[targetPlanId]
  if (plan?.content?.trim()) {
    await ctx.planStore.hydrateAnnotations(targetPlanId)
  } else {
    const sessionId = ref?.sessionId ?? plan?.sessionId ?? targetPlanId.split('__')[0]
    const planToolUseId = ref?.planToolUseId ?? plan?.planToolUseId ?? targetPlanId.split('__').slice(1).join('__')
    const cwd = plan?.cwd ?? ctx.activeSession?.workingDirectory ?? ctx.globalDefaults.workingDirectory
    const projectPath = plan?.projectPath ?? encodePathAsFolder(cwd)
    if (!sessionId || !planToolUseId || !cwd) return

    targetPlanId = await ctx.planStore.loadFromDisk({
      sessionId,
      planToolUseId,
      projectPath,
      cwd,
      status: ref?.status,
      ctx: ctx.ctx,
      provider: ctx.activeSession?.provider,
    })
  }

  plan = ctx.planStore.plans[targetPlanId]
  if (!plan?.content?.trim()) return

  // `secondary` forces the plan beside the conversation in the secondary pane
  // (the conversation-ref "pop out to side" action); otherwise it takes Focus.
  if (opts.secondary) ctx.panes.moveToSecondary({ kind: 'plan', planId: targetPlanId })
  else ctx.panes.openPlan(targetPlanId)
  ctx.isExpanded = true
}

export function closePlanModal(ctx: WorkspaceContext): void {
  ctx.panes.close()
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
    await ctx.apiFor(tabId).stopTab(ctx.ctxFor(tabId))
    ctx.interruptTab(tabId)
  }

  ctx.apiFor(tabId).resetTabSession(ctx.ctxFor(tabId))
  session.agentSessionId = null

  if (opts.provider && opts.modelId) {
    session.provider = opts.provider
    ctx.settings.update({ activeAgent: opts.provider })
    const profile = MODEL_PROFILES[opts.provider as keyof typeof MODEL_PROFILES]?.[opts.modelId]
    session.modelConfig = { modelId: opts.modelId, reasoningEffort: opts.reasoningEffort ?? (profile as ModelProfile)?.defaultReasoningEffort ?? 'high', contextWindow: null, fastMode: false }
    session.sessionModel = null
  } else if (opts.reasoningEffort) {
    session.modelConfig.reasoningEffort = opts.reasoningEffort
  }
  session.permissionMode = mode

  if (wasPreview && opts.useWorktree && !session.gitContext) {
    await ctx.environment.refreshTab(ctx, { tabId, cwd: plan.cwd })
  }

  if (opts.useWorktree !== undefined) {
    session.worktreeBaseBranch = opts.useWorktree ? (session.gitContext?.targetBranch ?? null) : null
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

  tab.input.planRefs = [
    { planId, sessionId: plan.sessionId, planToolUseId: plan.planToolUseId, title: plan.title, status: 'accepted' },
    ...(opts.planRefs ?? []).filter((r) => r.planId !== planId),
  ]
  tab.input.workRefs = opts.workRefs ? [...opts.workRefs] : []
  ctx.sendMessage(message)
  requestConversationScrollToBottom(tabId)
}

export async function rejectPlan(ctx: WorkspaceContext, planId: string, comment?: string): Promise<void> {
  if (ctx.planStore.previewDescriptor) await resumeFromPreview(ctx)
  const plan = ctx.planStore.plans[planId]
  if (!plan) return
  const tabId = resolvePlanTabId(ctx, plan)
  const session = ctx.sessionFor(tabId)
  const sessionIsLive = plan.questionId && plan.options?.length && session?.status === 'running'

  if (sessionIsLive) {
    const denyOption = plan.options!.find((o: PermissionOption) => o.kind === 'deny') ?? plan.options![plan.options!.length - 1]
    ctx.apiFor(tabId).respondPermission(ctx.ctxFor(tabId), plan.questionId!, denyOption.id)
    ctx.interruptTab(tabId)
  } else {
    ctx.apiFor(tabId).stopTab(ctx.ctxFor(tabId))
    ctx.interruptTab(tabId)
  }

  ctx.planStore.setStatus(planId, 'rejected')
  clearPlanWaiting(ctx, plan.sessionId)

  const inlineComments = plan.comments
  if (comment || inlineComments.length > 0) {
    ctx.setPermissionMode('plan')
    const parts: string[] = []
    if (comment) parts.push(comment)
    if (inlineComments.length > 0) parts.push(`Inline comments:\n${formatInlineComments(inlineComments)}`)
    ctx.sendMessage(`Please revise the plan with these comments:\n\n${parts.join('\n\n')}`)
  }

  requestConversationScrollToBottom(tabId)
}

// ─── Plan navigation ───

async function loadOrFindTab(ctx: WorkspaceContext, sessionId: string, cwd: string, projectPath: string, provider?: AgentId, title?: string): Promise<string> {
  const existing = findOpenTabForSession(sessionId, ctx.tabs, ctx.sessions, ctx.tabOrder, provider)
  if (existing) {
    ctx.selectTab(existing)
    return existing
  }
  const meta: SessionMeta = {
    sessionId,
    provider: provider ?? ctx.settings.activeAgent as AgentId,
    cwd,
    projectPath,
    slug: title ?? null,
    firstMessage: null,
    lastTimestamp: '',
    size: 0,
  }
  return await ctx.resumeSession(meta)
}

async function loadDescriptorPlan(ctx: WorkspaceContext, d: PlanDescriptor): Promise<string> {
  const id = await ctx.planStore.loadFromDisk({
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

  // Load sibling revisions in the background so the revision dropdown works.
  for (const rev of d.revisions) {
    const revId = planKey(d.sessionId, rev.planToolUseId)
    if (ctx.planStore.plans[revId]) continue
    void ctx.planStore.loadFromDisk({
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
  const existing = findOpenTabForSession(d.sessionId, ctx.tabs, ctx.sessions, ctx.tabOrder, d.provider)
  if (existing) {
    await loadDescriptorPlan(ctx, d)
    ctx.plansGalleryOpen = false
    ctx.selectTab(existing)
    openPlanModal(ctx, planKey(d.sessionId, d.planToolUseId))
    return
  }

  const planId = await loadDescriptorPlan(ctx, d)
  ctx.plansGalleryOpen = false
  ctx.planStore.previewDescriptor = d
  ctx.planStore.openPreview(planId)
  ctx.panes.openPlan(planId)
}

export async function resumeFromPreview(ctx: WorkspaceContext): Promise<void> {
  const d = ctx.planStore.previewDescriptor
  ctx.planStore.dismissPreview()
  if (d) {
    await loadOrFindTab(ctx, d.sessionId, d.cwd, d.projectPath, d.provider, d.title)
  }
}

export function closePlanPreview(ctx: WorkspaceContext): void {
  ctx.planStore.dismissPreview()
  ctx.plansGalleryOpen = true
}

export async function resumeSessionFromDescriptor(ctx: WorkspaceContext, d: PlanDescriptor): Promise<void> {
  ctx.planStore.dismissPreview()
  await loadDescriptorPlan(ctx, d)
  const tabId = await loadOrFindTab(ctx, d.sessionId, d.cwd, d.projectPath, d.provider, d.title)
  ctx.plansGalleryOpen = false
  closePlanModal(ctx)
  setTimeout(() => requestConversationScrollToBottom(tabId), 50)
}
