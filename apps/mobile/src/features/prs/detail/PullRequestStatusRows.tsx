// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestStatusRows.tsx and pullRequestStatus.ts (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import type { CheckItem } from '@solus/contracts/checks-types'
import type { PrStateAction } from '@solus/contracts/providers'
import { useApp } from '../../../app/app-context'
import { SymbolView, type AppSymbolName } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { ControlPillMenu } from '../../../components/ControlPillMenu'
import type { RootStackParamList } from '../../../navigation/routes'
import { branchMergeState, branchRowValue, checkItemLabel, reviewerStateLabel, type BranchMergeState, type CheckStatus } from '../lib/pr-presentation'
import { hasMergeConflicts } from '../lib/pull-request-permissions'
import { usePullRequestAgent } from './PullRequestAgentActions'
import { PullRequestAvatar, PullRequestCardRow, pullRequestStatus } from './pull-request-ui'
import { usePullRequestAction } from './use-pull-request-action'
import { OFFLINE_REASON, type PullRequestView } from './pull-request-view'

type Navigation = NativeStackNavigationProp<RootStackParamList>

type StatusAction = PrStateAction | 'revert'

const LIFECYCLE = {
  ready: { title: 'Mark ready for review', icon: 'checkmark.circle' },
  draft: { title: 'Convert to draft', icon: 'pencil' },
  close: { title: 'Close pull request', icon: 'xmark' },
  reopen: { title: 'Reopen pull request', icon: 'arrow.clockwise' },
  revert: { title: 'Revert', icon: 'arrow.uturn.backward' },
} as const satisfies Record<StatusAction, { title: string; icon: AppSymbolName }>

const CHECK_TONE = {
  passing: { icon: 'checkmark.circle', tint: 'accent-adaptive-emerald-600-400' },
  failing: { icon: 'exclamationmark.circle', tint: 'accent-danger-foreground' },
  pending: { icon: 'clock', tint: 'accent-warning-foreground' },
  neutral: { icon: 'minus', tint: 'accent-icon-muted' },
} as const satisfies Record<CheckStatus['tone'], { icon: AppSymbolName; tint: string }>

const CHECK_ORDER = { failing: 0, pending: 1, neutral: 2, passing: 3 } as const satisfies Record<CheckStatus['tone'], number>

/** The state in a word; a menu of the state changes the person may make. A
 *  merged pull request can be reverted: that opens a new pull request. */
export function PullRequestStatusMenu({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const navigation = useNavigation<Navigation>()
  const action = usePullRequestAction(view.ref)
  const status = pullRequestStatus(view.pr)
  const actions: StatusAction[] = action.busy ? [] : [...view.permissions.lifecycle, ...(view.permissions.canRevert ? ['revert' as const] : [])]
  const trigger = (
    <Pressable
      accessibilityRole={actions.length ? 'button' : undefined}
      accessibilityLabel={`Pull request status, ${status.label}`}
      disabled={!actions.length}
      className="min-h-8 flex-row items-center gap-1.5 active:opacity-70"
    >
      <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
      <Text className={`text-xs font-t3-medium ${status.text}`}>{action.running === 'lifecycle' ? 'Updating…' : action.running === 'revert' ? 'Reverting…' : status.label}</Text>
      {actions.length ? <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon-muted" /> : null}
    </Pressable>
  )
  if (!actions.length) return trigger
  const run = (lifecycle: PrStateAction) => app.pullRequestActions.setLifecycle(view.ref, lifecycle, view.pr.headSha)
  return (
    <ControlPillMenu
      title="Pull request status"
      actions={actions.map((id) => ({ id, title: LIFECYCLE[id].title, image: LIFECYCLE[id].icon, attributes: { destructive: id === 'close' } }))}
      onPressAction={({ nativeEvent }) => {
        const selected = actions.find((id) => id === nativeEvent.event)
        if (!selected) return
        if (selected === 'close') action.confirm('Close pull request?', 'Close this pull request without merging its changes?', 'Close', () => run('close'), true)
        else if (selected === 'revert') {
          action.confirm('Revert pull request?', `Open a new pull request that reverses the changes of #${view.pr.number}?`, 'Revert', async () => {
            navigation.push('PullRequest', await app.pullRequestActions.revert(view.ref))
          })
        } else void action.perform('Could not update this pull request', () => run(selected))
      }}
    >
      {trigger}
    </ControlPillMenu>
  )
}

function checkSummary(checks: readonly CheckItem[]) {
  const tones = checks.map((check) => checkItemLabel(check).tone)
  const failed = tones.filter((tone) => tone === 'failing').length
  const pending = tones.filter((tone) => tone === 'pending').length
  const passed = tones.filter((tone) => tone === 'passing').length
  const count = checks.length ? `${passed} of ${checks.length}` : undefined
  if (failed) return { title: `${failed} ${failed === 1 ? 'check' : 'checks'} failing`, count, ...CHECK_TONE.failing }
  if (pending) return { title: 'Checks running', count: `${pending} pending`, ...CHECK_TONE.pending }
  if (passed) return { title: passed === checks.length ? 'All checks passed' : 'Checks completed', count, ...CHECK_TONE.passing }
  return { title: checks.length ? 'Checks completed' : 'No checks reported', count, ...CHECK_TONE.neutral }
}

/** The checks of the current head; older runs say nothing about it. */
export function PullRequestChecksRow({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const agent = usePullRequestAgent(view)
  const [expanded, setExpanded] = useState(false)
  const summary = view.detail.checks
  const current = summary && summary.headSha === view.pr.headSha ? [...summary.required, ...summary.optional] : []
  const unavailable = view.detail.missing.includes('checks')
  const reading = view.detail.reading?.includes('checks') ?? false
  const totals = reading && current.length === 0
    ? { title: 'Reading checks…', count: undefined, ...CHECK_TONE.neutral }
    : unavailable && current.length === 0
      ? { title: 'Checks unavailable', count: undefined, ...CHECK_TONE.neutral }
      : checkSummary(current)
  const sorted = [...current].sort((a, b) => CHECK_ORDER[checkItemLabel(a).tone] - CHECK_ORDER[checkItemLabel(b).tone])
  const fixable = view.pr.state === 'open' && current.some((check) => checkItemLabel(check).tone === 'failing')
  const feedback = agent.actions.find((entry) => entry.task === 'feedback')
  return (
    <View>
      <PullRequestCardRow
        title={totals.title}
        icon={totals.icon}
        tint={totals.tint}
        {...(totals.count ? { value: totals.count } : {})}
        compact
        accessibilityLabel={`Checks, ${totals.title}`}
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <View className="pl-8">
          {fixable && agent.available && feedback && !feedback.disabled ? (
            <PullRequestCardRow title="Fix failing checks" icon="sparkles" busy={agent.starting} onPress={() => void agent.start('feedback')} />
          ) : null}
          {sorted.map((check) => {
            const status = checkItemLabel(check)
            const url = check.detailsUrl
            return (
              <PullRequestCardRow
                key={check.id}
                title={check.name}
                icon={CHECK_TONE[status.tone].icon}
                tint={CHECK_TONE[status.tone].tint}
                value={status.label}
                {...(check.appName ? { detail: check.appName } : {})}
                {...(url ? { onPress: () => void app.platform.openBrowser(url) } : {})}
              />
            )
          })}
          {current.length === 0 ? <Text className="px-4 py-3 text-xs text-foreground-muted">{reading ? 'Reading the checks…' : unavailable ? 'The host could not read the checks.' : 'No checks reported.'}</Text> : null}
          <PullRequestCardRow title="Open checks on GitHub" icon="arrow.up.right" onPress={() => void app.platform.openBrowser(`${view.pr.url}/checks`)} />
        </View>
      ) : null}
    </View>
  )
}

/**
 * The workflow runs of a fork pull request that GitHub holds until a
 * maintainer approves them, next to the checks. "Approve and run" names the
 * head the runs belong to, so the host refuses when the head moved.
 */
export function PullRequestWorkflowRunsRow({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const action = usePullRequestAction(view.ref)
  const [expanded, setExpanded] = useState(false)
  const runs = view.detail.workflowRuns?.runs ?? []
  const headSha = view.detail.workflowRuns?.headSha
  if (view.detail.missing.includes('workflowRuns') && view.permissions.canApproveWorkflows) {
    return <PullRequestCardRow title="Waiting workflow runs could not be read" icon="clock" tint="accent-icon-muted" compact />
  }
  if (runs.length === 0 || headSha === undefined) return null
  const { permissions } = view
  const reason = !permissions.connected ? OFFLINE_REASON : permissions.canApproveWorkflows ? null : 'Your account cannot approve these runs.'
  const title = `${runs.length} ${runs.length === 1 ? 'workflow waits' : 'workflows wait'} for approval`
  const approve = () => action.confirm(
    'Approve and run?',
    'These workflows run with the code of this fork. Read the workflow changes first.',
    'Approve',
    () => app.pullRequestActions.approveWorkflowRuns(view.ref, headSha),
  )
  return (
    <View>
      <PullRequestCardRow title={title} icon="clock" tint="accent-warning-foreground" compact expanded={expanded} onPress={() => setExpanded(!expanded)} />
      {expanded ? (
        <View className="pl-8">
          {runs.map((run) => {
            const url = run.url
            return <PullRequestCardRow key={run.id} title={run.name} icon="clock" tint="accent-warning-foreground" value="Waiting" {...(url ? { onPress: () => void app.platform.openBrowser(url) } : {})} />
          })}
          <PullRequestCardRow
            title={action.running === 'workflows' ? 'Approving…' : 'Approve and run'}
            icon="checkmark"
            busy={action.running === 'workflows'}
            {...(reason ? { detail: reason } : {})}
            {...(reason === null && !action.busy ? { onPress: approve } : {})}
          />
        </View>
      ) : null}
    </View>
  )
}

/** The reviewers: changes requested first, then approvals, then who is still asked. */
export function PullRequestReviewersRow({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const navigation = useNavigation<Navigation>()
  const [expanded, setExpanded] = useState(false)
  const reviewers = view.detail.overview.reviewers
  const requested = reviewers.filter((reviewer) => reviewer.state === 'CHANGES_REQUESTED')
  const approved = reviewers.filter((reviewer) => reviewer.state === 'APPROVED')
  const summary = view.detail.reading?.includes('overview')
    ? { title: 'Reading reviewers…', count: undefined, icon: 'person.2', tint: 'accent-icon-muted' } as const
    : requested.length
      ? { title: 'Changes requested', count: `${requested.length} ${requested.length === 1 ? 'reviewer' : 'reviewers'}`, icon: 'xmark.circle.fill', tint: 'accent-danger-foreground' } as const
      : approved.length
        ? { title: approved.length === 1 ? `Approved by ${approved[0]!.login}` : 'Reviews approved', count: `${approved.length} approved`, icon: 'checkmark.circle', tint: 'accent-adaptive-emerald-600-400' } as const
        : { title: reviewers.length ? 'Awaiting review' : 'Request a review', count: reviewers.length ? `${reviewers.length} requested` : 'None assigned', icon: 'person.2', tint: 'accent-icon-muted' } as const
  return (
    <View>
      <PullRequestCardRow title={summary.title} icon={summary.icon} tint={summary.tint} {...(summary.count ? { value: summary.count } : {})} compact expanded={expanded} onPress={() => setExpanded(!expanded)} />
      {expanded ? (
        <View className="pl-8">
          {reviewers.map((reviewer) => (
            <View key={reviewer.login} accessible accessibilityLabel={`${reviewer.login}, ${reviewerStateLabel(reviewer.state)}`} className="min-h-14 flex-row items-center gap-3 px-4 py-2">
              <PullRequestAvatar login={reviewer.login} avatarUrl={reviewer.avatarUrl ?? null} size={32} />
              <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>{reviewer.login}</Text>
              <Text className="text-xs text-foreground-muted">{reviewerStateLabel(reviewer.state)}</Text>
            </View>
          ))}
          {view.permissions.canRequestReviewers ? (
            <PullRequestCardRow title="Request review" icon="person.2" onPress={() => navigation.navigate('PullRequestReviewers', view.ref)} />
          ) : (
            <PullRequestCardRow
              title="View reviewers on GitHub"
              icon="arrow.up.right"
              {...(view.permissions.connected ? {} : { detail: 'Connect to this host to request a review.' })}
              onPress={() => void app.platform.openBrowser(view.pr.url)}
            />
          )}
        </View>
      ) : null}
    </View>
  )
}

const BRANCH_ROW = {
  conflicts: { title: (baseRef: string) => `Conflicts with ${baseRef}`, icon: 'exclamationmark.triangle', tint: 'accent-danger-foreground' },
  clean: { title: (baseRef: string) => `No conflicts with ${baseRef}`, icon: 'checkmark.circle', tint: 'accent-adaptive-emerald-600-400' },
  unknown: { title: () => 'Branch', icon: 'arrow.branch', tint: undefined },
} as const satisfies Record<BranchMergeState, { title: (baseRef: string) => string; icon: AppSymbolName; tint: string | undefined }>

/** Whether the branch merges cleanly, with the branch fixes the person may run. */
export function PullRequestBranchRow({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const action = usePullRequestAction(view.ref)
  const agent = usePullRequestAgent(view)
  const { pr, permissions } = view
  const conflicting = hasMergeConflicts(pr)
  const clean = pr.state === 'open' && pr.mergeable === true
  const behind = pr.mergeStateStatus === 'behind'
  const conflictTask = agent.actions.find((entry) => entry.task === 'conflicts')
  const canResolve = agent.available && conflicting && conflictTask !== undefined && !conflictTask.disabled
  const canUpdate = permissions.canUpdateBranch && !action.busy
  const mergeState = branchMergeState(conflicting, clean)
  const value = branchRowValue({ updating: action.running === 'update-branch', behind, mergeState, baseRef: pr.baseRef })
  const presentation = BRANCH_ROW[mergeState]
  const row = (
    <PullRequestCardRow
      title={presentation.title(pr.baseRef)}
      icon={presentation.icon}
      tint={presentation.tint}
      value={value}
      compact
      menu={canUpdate || canResolve}
      accessibilityLabel={`Branch, ${value ?? (conflicting ? 'has conflicts' : 'no conflicts')}`}
    />
  )
  if (!canUpdate && !canResolve) return row
  return (
    <ControlPillMenu
      title="Branch"
      actions={[
        ...(canResolve ? [{ id: 'conflicts', title: 'Resolve conflicts with an agent', image: 'sparkles' }] : []),
        ...(canUpdate ? [{ id: 'update', title: `Update with ${pr.baseRef}`, image: 'arrow.up.circle' }] : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === 'conflicts') void agent.start('conflicts')
        else if (nativeEvent.event === 'update') {
          action.confirm('Update branch?', `Merge ${pr.baseRef} into ${pr.headRef} on GitHub.`, 'Update', () => app.pullRequestActions.updateBranch(view.ref, pr.headSha))
        }
      }}
    >
      {row}
    </ControlPillMenu>
  )
}
