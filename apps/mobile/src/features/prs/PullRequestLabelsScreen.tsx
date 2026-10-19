import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import type { PrLabel } from '@solus/contracts/providers'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { EmptyState } from '../../components/EmptyState'
import { MaterialButton } from '../../components/MaterialButton'
import type { ScreenProps } from '../../navigation/routes'
import { pullRequestLabelColor } from './lib/pull-request-list'
import { pullRequestPermissions } from './lib/pull-request-permissions'
import { shownValue } from './pull-request-reads'
import { OFFLINE_REASON } from './detail/pull-request-view'

/**
 * Picks the labels of a pull request from the repository's labels. T3 Code's
 * phone app shows labels but does not edit them; Solus has the host call, so
 * this list sets the whole label set in one write when the person saves.
 */
export function PullRequestLabelsScreen({ navigation, route }: ScreenProps<'PullRequestLabels'>) {
  const { hostId, projectPath, number } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const app = useApp()
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.detailOf(ref))
  const viewerLogin = useListened(app.pullRequests.changes, () => shownValue(app.pullRequests.hostOf(hostId))?.viewerLogin ?? null)
  const connected = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase === 'connected')
  const pr = shownValue(state)?.overview.pullRequest ?? null
  const permissions = pullRequestPermissions(pr, viewerLogin, connected)
  const [labels, setLabels] = useState<{ kind: 'loading' } | { kind: 'loaded'; labels: PrLabel[] } | { kind: 'error'; message: string }>({ kind: 'loading' })
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = useMemo(() => new Set(pr?.labels.map((label) => label.name) ?? []), [pr])
  const selected = chosen ?? current

  const load = useCallback(() => {
    if (!connected) return
    setLabels({ kind: 'loading' })
    app.pullRequestActions.labelCandidates(ref).then(
      (list) => setLabels({ kind: 'loaded', labels: list }),
      (cause: unknown) => setLabels({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
    )
  }, [app, ref, connected])
  useEffect(load, [load])

  const toggle = (name: string) => {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setChosen(next)
  }
  const changed = chosen !== null && (chosen.size !== current.size || [...chosen].some((name) => !current.has(name)))
  const save = async () => {
    if (!changed || busy) return
    setBusy(true)
    setError(null)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so catch and finally see both.
    await (async () => {
      await app.pullRequestActions.setLabels(ref, [...selected])
      navigation.goBack()
    })().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Could not change the labels. Try again.')
    }).finally(() => {
      setBusy(false)
    })
  }
  // Labels on the pull request stay listed even when the repository list does not have them.
  const rows = labels.kind === 'loaded'
    ? [...labels.labels, ...(pr?.labels ?? []).filter((label) => !labels.labels.some((entry) => entry.name === label.name))]
    : []

  return (
    <View className="flex-1 bg-sheet">
      <FlatList
        data={rows}
        keyExtractor={(label) => label.name}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-3 px-4 py-4">
            {!connected ? <Text className="text-xs text-foreground-muted">{OFFLINE_REASON}</Text> : !permissions.canManageLabels ? <Text className="text-xs text-foreground-muted">Your account cannot change the labels of this pull request.</Text> : null}
            {error ? <Text selectable className="text-sm text-danger-foreground">{error}</Text> : null}
          </View>
        }
        renderItem={({ item }) => {
          const on = selected.has(item.name)
          const color = pullRequestLabelColor(item.color)
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: !permissions.canManageLabels || busy }}
              disabled={!permissions.canManageLabels || busy}
              onPress={() => toggle(item.name)}
              className="min-h-13 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
            >
              <View className="size-3 rounded-full bg-subtle" style={color ? { backgroundColor: color } : undefined} />
              <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>{item.name}</Text>
              {on ? <SymbolView name="checkmark" size={15} tintColorClassName="accent-icon" /> : null}
            </Pressable>
          )
        }}
        ListEmptyComponent={labels.kind === 'loading' && connected ? <ActivityIndicator className="my-8" /> : (
          <View className="px-4 py-6">
            <EmptyState
              variant="plain"
              title={labels.kind === 'error' ? 'Could not load labels' : 'No labels'}
              detail={labels.kind === 'error' ? labels.message : !connected ? OFFLINE_REASON : 'This repository has no labels.'}
              {...(labels.kind === 'error' ? { actionLabel: 'Try again', onAction: load } : {})}
            />
          </View>
        )}
        ListFooterComponent={
          <View className="px-4 pt-4">
            <MaterialButton label={busy ? 'Saving…' : 'Save labels'} tone="primary" fullWidth loading={busy} disabled={!changed || !permissions.canManageLabels} onPress={() => void save()} />
          </View>
        }
      />
    </View>
  )
}
