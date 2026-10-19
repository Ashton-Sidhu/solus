// Adapted from T3 Code apps/mobile/src/features/pull-requests/guide/PullRequestGuideScreen.tsx, GuideOutline.tsx, and GuideNotice.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import type { GuideSection, ReviewGuide } from '@solus/contracts/review'
import { useApp, useListened } from '../../../app/app-context'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import type { RootStackParamList } from '../../../navigation/routes'
import { guideNotice, reviewGuideState } from '../lib/pull-request-guide-state'
import { GUIDE_ATTENTION_LABELS, guideExcerpts, guideFileCount, guideStops, type GuideDiffFocus } from '../lib/pull-request-guide-tour'
import { shownValue } from '../pull-request-reads'
import { GuideNoticeCard } from './GuideNoticeCard'
import { PullRequestMarkdown } from './PullRequestMarkdown'
import { ReviewGuideExcerpt } from './ReviewGuideExcerpt'
import { PullRequestCardGroup, PullRequestCardRow } from './pull-request-ui'
import type { PullRequestView } from './pull-request-view'

type Navigation = NativeStackNavigationProp<RootStackParamList>

/**
 * The Guide tab: the state of the guide in one stable card, then the guide as
 * a tour. The outline lists one stop for each section; a stop shows its
 * explanation, the call it asks for, and its excerpts. A guide for an older
 * head stays readable, without excerpts, until it is written again.
 */
export function PullRequestGuideTab(props: { readonly view: PullRequestView; readonly onOpenFile: (path: string, focus: GuideDiffFocus | null) => void }) {
  const { view } = props
  const app = useApp()
  const state = useListened(app.pullRequestGuides.changes, () => app.pullRequestGuides.guideOf(view.ref))
  const starting = useListened(app.pullRequestGuides.changes, () => app.pullRequestGuides.isStarting(view.ref))
  const startError = useListened(app.pullRequestGuides.changes, () => app.pullRequestGuides.startErrorOf(view.ref))
  const notice = guideNotice({ state, pr: view.pr, starting, startError })
  const { guide, stale, running } = reviewGuideState(shownValue(state), view.pr)
  const stops = useMemo(() => (guide ? guideStops(guide) : []), [guide])
  const [position, setPosition] = useState<number | null>(null)
  const write = () => void app.pullRequestGuides.request(view.ref, view.pr)
  const reload = () => void app.pullRequestGuides.load(view.ref, view.pr)
  const canWrite = view.permissions.connected
  const stop = position !== null ? stops[position] : undefined
  return (
    <View className="w-full max-w-[760px] gap-5 self-center">
      <GuideNoticeCard notice={notice} compact={guide !== null} canWrite={canWrite} onWrite={write} onReload={reload} />
      {guide && stop && position !== null ? (
        <GuideStop
          view={view}
          stop={stop}
          position={position}
          count={stops.length}
          stale={stale}
          nextTitle={stops[position + 1]?.title ?? null}
          onMove={setPosition}
          onOpenFile={props.onOpenFile}
        />
      ) : guide ? (
        <GuideOutline guide={guide} stops={stops} onOpen={setPosition} {...(canWrite && !running && !stale ? { onRewrite: write } : {})} />
      ) : null}
    </View>
  )
}

function stopFileLabel(section: GuideSection): string {
  const first = section.files[0]?.path.split('/').at(-1)
  if (!first) return 'Context'
  return section.files.length > 1 ? `${first} +${section.files.length - 1}` : first
}

function GuideOutline(props: { readonly guide: ReviewGuide; readonly stops: readonly GuideSection[]; readonly onOpen: (position: number) => void; readonly onRewrite?: () => void }) {
  const files = guideFileCount(props.guide)
  return (
    <View>
      <View className="mb-4 gap-2">
        <Text className="text-xl leading-7 font-t3-semibold">{props.guide.title}</Text>
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-sm text-foreground-muted">{`${props.stops.length} ${props.stops.length === 1 ? 'stop' : 'stops'} through ${files} ${files === 1 ? 'file' : 'files'}`}</Text>
          {props.onRewrite ? (
            <Pressable accessibilityRole="button" onPress={props.onRewrite} className="min-h-11 flex-row items-center gap-1.5 active:opacity-60">
              <SymbolView name="arrow.clockwise" size={14} tintColorClassName="accent-icon-muted" />
              <Text className="text-xs text-foreground-muted">Write again</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {props.guide.summary.trim() ? <View className="mb-6"><PullRequestMarkdown markdown={props.guide.summary} /></View> : null}
      {props.stops.map((stop, position) => (
        <Pressable key={stop.id} accessibilityRole="button" accessibilityLabel={`Stop ${position + 1}: ${stop.title}`} onPress={() => props.onOpen(position)} className="flex-row gap-4 active:opacity-60">
          <View className="w-8 items-center">
            <View className="h-8 w-8 items-center justify-center rounded-full border border-border bg-grouped-card">
              <Text className="text-sm font-t3-medium tabular-nums">{position + 1}</Text>
            </View>
            {position < props.stops.length - 1 ? <View className="min-h-5 w-px flex-1 bg-border-subtle" /> : null}
          </View>
          <View className="min-w-0 flex-1 gap-2 pb-7 pt-0.5">
            <Text className="text-base leading-6 font-t3-medium">{stop.title}</Text>
            <View className="flex-row items-center gap-1.5">
              {stop.attention ? <SymbolView name="eye" size={14} tintColorClassName="accent-warning-foreground" /> : null}
              <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>{stopFileLabel(stop)}</Text>
            </View>
          </View>
          <View className="pt-2"><SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" /></View>
        </Pressable>
      ))}
      {props.stops.length > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => props.onOpen(0)} className="min-h-11 flex-row items-center justify-end gap-2 active:opacity-60">
          <Text className="text-sm font-t3-medium">Start tour</Text>
          <SymbolView name="arrow.right" size={17} tintColorClassName="accent-foreground" />
        </Pressable>
      ) : (
        <Text className="text-sm text-foreground-muted">This guide has no stops.</Text>
      )}
    </View>
  )
}

function GuideStop(props: {
  readonly view: PullRequestView
  readonly stop: GuideSection
  readonly position: number
  readonly count: number
  readonly stale: boolean
  readonly nextTitle: string | null
  readonly onMove: (position: number | null) => void
  readonly onOpenFile: (path: string, focus: GuideDiffFocus | null) => void
}) {
  const { stop, position, count } = props
  const navigation = useNavigation<Navigation>()
  const excerpts = useMemo(() => guideExcerpts(stop), [stop])
  const otherFiles = stop.files.filter((file) => !excerpts.some((excerpt) => excerpt.path === file.path))
  // The file list stays short; the reader asks for the rest.
  const [filesExpanded, setFilesExpanded] = useState(false)
  const canExpandFiles = otherFiles.length > 4
  const listedFiles = filesExpanded || !canExpandFiles ? otherFiles : otherFiles.slice(0, 4)
  const canReview = props.view.permissions.verdicts.length > 0 && !props.stale
  const last = position >= count - 1
  return (
    <View className="gap-5">
      <View className="flex-row items-center justify-between">
        <Pressable accessibilityRole="button" onPress={() => props.onMove(null)} className="min-h-11 flex-row items-center gap-1.5 active:opacity-60">
          <SymbolView name="chevron.left" size={13} tintColorClassName="accent-icon-muted" />
          <Text className="text-sm text-foreground-muted">All stops</Text>
        </Pressable>
        <Text className="text-xs text-foreground-muted">{`Stop ${position + 1} of ${count}`}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous stop" disabled={position === 0} onPress={() => props.onMove(position - 1)} className="size-11 items-center justify-center disabled:opacity-30 active:opacity-60">
          <SymbolView name="arrow.left" size={16} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      <Text accessibilityRole="header" className="text-2xl leading-8 font-t3-semibold">{stop.title}</Text>
      {stop.explanation.trim() ? <PullRequestMarkdown markdown={stop.explanation} /> : null}
      {stop.attention ? (
        <View className="gap-3 rounded-xl border border-border bg-grouped-card p-4">
          <View className="flex-row items-center gap-2">
            <SymbolView name="eye" size={17} tintColorClassName="accent-warning-foreground" />
            <Text className="text-sm font-t3-semibold">{`Look closely · ${GUIDE_ATTENTION_LABELS[stop.attention.kind]}`}</Text>
          </View>
          <PullRequestMarkdown markdown={stop.attention.note} />
        </View>
      ) : null}
      {props.stale ? (
        <Text className="text-sm text-foreground-muted">Excerpts are hidden until the guide is written again for the latest changes.</Text>
      ) : (
        excerpts.map((excerpt) => <ReviewGuideExcerpt key={excerpt.path} excerpt={excerpt} onOpen={() => props.onOpenFile(excerpt.path, excerpt.focus)} />)
      )}
      {otherFiles.length > 0 ? (
        <PullRequestCardGroup>
          {listedFiles.map((file, index) => (
            <PullRequestCardRow key={file.path} title={file.path} icon="doc" detail={`+${file.additions} −${file.deletions}`} last={!canExpandFiles && index === listedFiles.length - 1} onPress={() => props.onOpenFile(file.path, null)} />
          ))}
          {canExpandFiles ? (
            <PullRequestCardRow
              title={filesExpanded ? 'Show fewer files' : `Show ${otherFiles.length - 4} more files`}
              icon="ellipsis"
              expanded={filesExpanded}
              last
              onPress={() => setFilesExpanded((expanded) => !expanded)}
            />
          ) : null}
        </PullRequestCardGroup>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={!last ? 'Next stop' : canReview ? 'Finish review' : 'Finish tour'}
        className="mt-2 flex-row items-center gap-4 border-t border-border-subtle pt-5 pb-2 active:opacity-60"
        onPress={() => {
          if (!last) props.onMove(position + 1)
          else if (canReview) navigation.navigate('PullRequestReview', { ...props.view.ref, mode: 'review' })
          else props.onMove(null)
        }}
      >
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">{!last ? `Next · ${position + 2} of ${count}` : 'End of guide'}</Text>
          <Text className="text-base font-t3-semibold">{!last ? props.nextTitle : canReview ? 'Finish review' : 'Finish tour'}</Text>
        </View>
        <View className="h-11 w-11 items-center justify-center rounded-full bg-foreground">
          <SymbolView name={!last ? 'arrow.right' : 'checkmark'} size={20} tintColorClassName="accent-screen" />
        </View>
      </Pressable>
    </View>
  )
}
