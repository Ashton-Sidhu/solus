// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestMergeControls.tsx and pullRequestActions.ts (MIT, see UPSTREAM.md).
import { useState } from 'react'
import { ActivityIndicator, Alert, Pressable, View } from 'react-native'
import type { PrMergeMethod, PullRequest } from '@solus/contracts/providers'
import { useApp } from '../../../app/app-context'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import { ControlPillMenu } from '../../../components/ControlPillMenu'
import { cn } from '../../../lib/cn'
import { stackMergePlan, type StackMergePlan } from '../lib/pull-request-permissions'
import type { PullRequestActionKind } from '../pull-request-actions'
import { usePullRequestAction } from './use-pull-request-action'
import type { PullRequestView } from './pull-request-view'

const MERGE_METHODS = {
  squash: { title: 'Squash and merge', short: 'squash' },
  merge: { title: 'Create a merge commit', short: 'merge commit' },
  rebase: { title: 'Rebase and merge', short: 'rebase' },
} as const satisfies Record<PrMergeMethod, { title: string; short: string }>

/**
 * The merge button, the merge method, and auto-merge. A merge names the head
 * the person was shown, so the host refuses it when the branch moved. In a
 * stack, "Merge stack" lands this pull request and the open layers below it
 * in one host operation, with the layer heads the person was shown.
 */
export function PullRequestMergeControls({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const action = usePullRequestAction(view.ref)
  const { pr, permissions } = view
  const [chosen, setChosen] = useState<PrMergeMethod | null>(null)
  const methods = permissions.mergeMethods
  const method = chosen && methods.includes(chosen) ? chosen : permissions.defaultMergeMethod
  const busy = action.busy
  const canMerge = permissions.canMerge && method !== null && !busy
  const label = !permissions.connected ? 'Connect to merge' : method ? MERGE_METHODS[method].title : 'Merge unavailable'
  const autoMerge = permissions.canDisableAutoMerge ? 'disable' : permissions.canEnableAutoMerge && method ? 'enable' : null
  const merge = () => {
    if (!canMerge || !method) return
    action.confirm('Merge pull request?', `Merge #${pr.number} into ${pr.baseRef} with ${MERGE_METHODS[method].short}.`, 'Merge', () => app.pullRequestActions.merge(view.ref, method, pr.headSha))
  }
  const toggleAutoMerge = () => {
    if (autoMerge === 'disable') {
      action.confirm('Disable auto-merge?', 'GitHub will not merge this pull request on its own.', 'Disable', () => app.pullRequestActions.disableAutoMerge(view.ref))
    } else if (autoMerge === 'enable' && method) {
      action.confirm('Enable auto-merge?', `GitHub merges #${pr.number} with ${MERGE_METHODS[method].short} when its requirements pass.`, 'Enable', () => app.pullRequestActions.enableAutoMerge(view.ref, method, pr.headSha))
    }
  }
  if (pr.state !== 'open') return null
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <View className={cn('flex-row overflow-hidden rounded-xl border-continuous', canMerge ? 'bg-prominent-action' : 'bg-subtle-strong')}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: !canMerge, busy: action.running === 'merge' }}
          disabled={!canMerge}
          onPress={merge}
          className="min-h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 px-3 py-2 active:opacity-70"
        >
          <MergeButtonContent running={action.running} canMerge={canMerge} label={label} />
        </Pressable>
        {methods.length > 0 && permissions.connected ? (
          <ControlPillMenu
            title="Merge options"
            actions={[
              ...methods.map((id) => ({ id, title: MERGE_METHODS[id].title, state: id === method ? 'on' as const : 'off' as const, attributes: { disabled: busy } })),
              ...(autoMerge ? [{ id: 'auto-merge', title: autoMerge === 'disable' ? 'Disable auto-merge' : 'Enable auto-merge', image: 'clock', attributes: { disabled: busy } }] : []),
            ]}
            onPressAction={({ nativeEvent }) => {
              const selected = methods.find((id) => id === nativeEvent.event)
              if (selected) setChosen(selected)
              else if (nativeEvent.event === 'auto-merge') toggleAutoMerge()
            }}
          >
            <Pressable accessibilityRole="button" accessibilityLabel="Merge options" className="min-h-11 w-11 items-center justify-center border-l border-border-subtle">
              <SymbolView name="chevron.down" size={13} tintColorClassName={canMerge ? 'accent-prominent-action-foreground' : 'accent-icon-muted'} />
            </Pressable>
          </ControlPillMenu>
        ) : null}
      </View>
      <MergeNotes unavailableReason={permissions.mergeUnavailableReason} pr={pr} />
      <StackMergeButton view={view} method={method} />
    </View>
  )
}

/** "Merge stack": shown when the host and the account can merge a stack, also
 *  when only this layer would land, as on desktop and web. */
function StackMergeButton({ view, method }: { readonly view: PullRequestView; readonly method: PrMergeMethod | null }) {
  const app = useApp()
  const action = usePullRequestAction(view.ref)
  const plan = stackMergePlan(view.pr, view.detail.stack, view.permissions.connected, method)
  if (!plan || plan.layers.length === 0) return null
  const layerCount = plan.layers.length === 1 ? '1 stack layer' : `${plan.layers.length} stack layers`
  const enabled = plan.reason === null && method !== null && !action.busy
  const merge = () => {
    if (!enabled || !method) return
    action.confirm(
      `Merge ${layerCount}?`,
      `${plan.layers.length === 1 ? 'This layer lands' : 'These layers land'} on ${plan.base} with ${MERGE_METHODS[method].short}, from the bottom up:\n${stackLayerList(plan)}\nLayers above #${view.pr.number} stay open.`,
      'Merge stack',
      async () => {
        const result = await app.pullRequestActions.mergeStack(view.ref, { stackNumber: plan.stackNumber, method, expectedHeads: plan.expectedHeads })
        if (result.status === 'queued') Alert.alert('Stack queued', 'GitHub put the stack in its merge queue. It merges when the queue passes it.')
      },
    )
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Merge stack, ${layerCount} through #${view.pr.number}`}
        accessibilityState={{ disabled: !enabled, busy: action.running === 'merge' }}
        disabled={!enabled}
        onPress={merge}
        className="min-h-11 flex-row items-center justify-center gap-2 rounded-xl border border-border-subtle border-continuous px-3 py-2 active:opacity-70"
      >
        <SymbolView name="square.3.layers.3d" size={15} tintColorClassName={enabled ? 'accent-foreground' : 'accent-icon-muted'} />
        <Text className={cn('text-sm font-t3-semibold', enabled ? 'text-foreground' : 'text-foreground-muted')}>Merge stack ({plan.layers.length})</Text>
      </Pressable>
      {plan.reason ? <Text className="px-1 text-xs text-foreground-muted">{plan.reason}</Text> : null}
    </>
  )
}

function stackLayerList(plan: StackMergePlan): string {
  return plan.layers.map((layer) => `#${layer.number} ${layer.title || layer.headRef}`).join('\n')
}

/** The symbol and label of the merge button, or a spinner while a merge write runs. */
function MergeButtonContent(props: { readonly running: PullRequestActionKind | null; readonly canMerge: boolean; readonly label: string }) {
  const { running, canMerge } = props
  return (
    <>
      {running === 'merge' || running === 'auto-merge' ? (
        <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
      ) : (
        <SymbolView name="arrow.triangle.merge" size={16} tintColorClassName={canMerge ? 'accent-prominent-action-foreground' : 'accent-icon-muted'} />
      )}
      <Text className={cn('shrink text-center text-sm font-t3-semibold', canMerge ? 'text-prominent-action-foreground' : 'text-foreground-muted')}>
        {running === 'merge' ? 'Merging…' : props.label}
      </Text>
    </>
  )
}

/** Why the merge is not available, and the auto-merge that is on. */
function MergeNotes({ unavailableReason, pr }: { readonly unavailableReason: string | null; readonly pr: PullRequest }) {
  return (
    <>
      {unavailableReason ? <Text className="px-1 text-xs text-foreground-muted">{unavailableReason}</Text> : null}
      {pr.autoMergeEnabled ? (
        <Text className="px-1 text-xs text-foreground-muted">Auto-merge is on{pr.autoMergeMethod ? ` · ${MERGE_METHODS[pr.autoMergeMethod].short}` : ''}</Text>
      ) : null}
    </>
  )
}
