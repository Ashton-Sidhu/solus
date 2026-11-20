import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { Alert, Pressable, View } from 'react-native'
import type { PrReactionContent, PrReactions } from '@solus/contracts/pr-social'
import type { RepoRef } from '@solus/contracts/providers'
import { PrReactionWrites, PR_REACTIONS, reactionSummary, shownReactions } from '@solus/client-core/pr-social'
import { useApp, useListened } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { ControlPillMenu } from '../../components/ControlPillMenu'

interface PrReactionsValue {
  /** Changes when a write changes what a bar shows. */
  readonly version: number
  readonly writes: PrReactionWrites
  /** The host is connected, so a write can reach GitHub. */
  readonly canWrite: boolean
  readonly toggle: (targetId: string | null, content: PrReactionContent, read: PrReactions | undefined) => void
}

const PrReactionsContext = createContext<PrReactionsValue | null>(null)

/** The reaction writes of a pull request screen. The reactions come with the
 *  pull request, its comments, and its threads; every bar under this passes
 *  them in and shows a write over them until a read catches up. */
export function PrReactionsProvider({
  hostId,
  repo,
  number,
  children
}: {
  hostId: string
  repo: RepoRef | null
  number: number
  children: ReactNode
}) {
  const app = useApp()
  const identity = useListened(app.account.changes, () =>
    JSON.stringify([app.account.syncAccount, app.account.organizationId])
  )
  const connected = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness === 'ready')
  const host = repo?.host
  const owner = repo?.owner
  const name = repo?.repo
  const writes = useMemo(
    () =>
      host && owner && name
        ? new PrReactionWrites(
            () => {
              if (JSON.stringify([app.account.syncAccount, app.account.organizationId]) !== identity)
                throw new Error('The account changed. Refresh this PR.')
              const connection = app.connections.connection(hostId)
              if (!connection || connection.state.readiness !== 'ready')
                throw new Error('The PR host is disconnected.')
              return connection.api
            },
            { host, owner, repo: name },
            number
          )
        : null,
    [app, identity, hostId, host, owner, name, number]
  )
  const version = useSyncExternalStore(
    writes?.subscribe ?? noSubscription,
    () => writes?.version ?? 0,
    () => writes?.version ?? 0
  )
  useEffect(() => (writes ? () => writes.dispose() : undefined), [writes])
  const value = useMemo((): PrReactionsValue | null => {
    if (!writes) return null
    return {
      version,
      writes,
      canWrite: connected,
      toggle: (targetId, content, read) =>
        void writes
          .toggle(targetId, content, read)
          .catch((error) =>
            Alert.alert('Could not change the reaction', error instanceof Error ? error.message : String(error))
          )
    }
  }, [writes, version, connected])
  return <PrReactionsContext.Provider value={value}>{children}</PrReactionsContext.Provider>
}

const noSubscription = () => () => {}

/** What a bar shows: the read's reactions, or a write over them. */
function useShownReactions(targetId: string | null, read: PrReactions | undefined) {
  const page = useContext(PrReactionsContext)
  const reactions = page ? page.writes.shown(targetId, read) : read
  const canReact = !!page?.canWrite && !!reactions?.viewerCanReact
  return { page, reactions, canReact }
}

/** The add-reaction control: GitHub's eight reactions in a native menu. One
 *  the person already made shows checked, and choosing it takes it back.
 *  Absent where the person may not react or the host is offline. */
export function PrReactionPicker({ targetId, reactions: read }: { targetId: string | null; reactions: PrReactions | undefined }) {
  const { page, reactions, canReact } = useShownReactions(targetId, read)
  if (!page || !reactions || !canReact) return null
  return (
    <ControlPillMenu
      title="React"
      actions={PR_REACTIONS.map((choice) => ({
        id: choice.content,
        title: `${choice.label}  ${choice.name}`,
        state: reactions.groups.some((group) => group.content === choice.content && group.viewerHasReacted) ? 'on' : 'off'
      }))}
      onPressAction={({ nativeEvent }) => {
        const choice = PR_REACTIONS.find((item) => item.content === nativeEvent.event)
        if (choice) page.toggle(targetId, choice.content, read)
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add reaction"
        hitSlop={8}
        className="size-8 items-center justify-center rounded-full border border-border-subtle active:opacity-60"
      >
        <SymbolView name="face.smiling" size={15} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </ControlPillMenu>
  )
}

/** The reactions under the description (`targetId` null) or a comment: one
 *  pill for each reaction someone made, with its count. A comment with no
 *  reactions shows nothing; its header holds the add control. Where the
 *  person may not react, or offline, the pills only show; a long press reads
 *  out who reacted. */
export function PrReactionBar({ targetId, reactions: read }: { targetId: string | null; reactions: PrReactions | undefined }) {
  const { page, reactions, canReact } = useShownReactions(targetId, read)
  const shown = shownReactions(reactions)
  if (!reactions || (shown.length === 0 && !(targetId === null && canReact))) return null
  return (
    <View className="flex-row flex-wrap items-center gap-1.5" accessibilityLabel="Reactions">
      {shown.map((reaction) => (
        <Pressable
          key={reaction.content}
          accessibilityRole="button"
          accessibilityLabel={reactionSummary(reaction)}
          accessibilityState={{ selected: reaction.viewerHasReacted, disabled: !canReact }}
          onPress={() => {
            if (canReact) page?.toggle(targetId, reaction.content, read)
          }}
          onLongPress={() => Alert.alert(`${reaction.label} ${reaction.name}`, reactionSummary(reaction))}
          className={`h-8 flex-row items-center gap-1 rounded-full border px-2.5 ${canReact ? 'active:opacity-60' : ''} ${reaction.viewerHasReacted ? 'border-primary bg-secondary' : 'border-border-subtle'}`}
        >
          <Text className="text-sm">{reaction.label}</Text>
          <Text className={`text-xs font-t3-medium ${reaction.viewerHasReacted ? 'text-primary-text' : 'text-foreground-muted'}`}>{reaction.count}</Text>
        </Pressable>
      ))}
      <PrReactionPicker targetId={targetId} reactions={read} />
    </View>
  )
}
