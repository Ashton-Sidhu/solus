// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestRouteScreen.tsx (overview) and PullRequestStackCard.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { useApp } from '../../../app/app-context'
import { SymbolView } from '../../../components/AppSymbol'
import { AppText as Text } from '../../../components/AppText'
import type { RootStackParamList } from '../../../navigation/routes'
import { pullRequestLabelColor } from '../lib/pull-request-list'
import { PullRequestDescription } from './PullRequestDescription'
import { PullRequestMergeControls } from './PullRequestMergeControls'
import { PullRequestBranchRow, PullRequestChecksRow, PullRequestReviewersRow, PullRequestWorkflowRunsRow } from './PullRequestStatusRows'
import { PullRequestCardGroup, PullRequestCardRow, PullRequestDiffStats, PullRequestSectionHeading, pullRequestStatus } from './pull-request-ui'
import type { PullRequestView } from './pull-request-view'

type Navigation = NativeStackNavigationProp<RootStackParamList>

/** The Overview tab: the stack, the status rows and merge, labels, the
 *  description, and the changed files. */
export function PullRequestOverview(props: { readonly view: PullRequestView; readonly onOpenFile: (path: string) => void }) {
  const { view } = props
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  return (
    <View className="gap-5">
      <PullRequestStackCard view={view} />
      <PullRequestCardGroup>
        <PullRequestChecksRow view={view} />
        <PullRequestWorkflowRunsRow view={view} />
        <PullRequestReviewersRow view={view} />
        <PullRequestBranchRow view={view} />
        <PullRequestMergeControls view={view} />
      </PullRequestCardGroup>
      <PullRequestLabels view={view} />
      <PullRequestDescription markdown={view.pr.body} expanded={descriptionExpanded} onExpandedChange={setDescriptionExpanded} />
      <ChangedFilesSummary view={view} onOpenFile={props.onOpenFile} />
    </View>
  )
}

function PullRequestLabels({ view }: { readonly view: PullRequestView }) {
  const navigation = useNavigation<Navigation>()
  const { labels } = view.pr
  if (labels.length === 0 && !view.permissions.canManageLabels) return null
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      {labels.map((label) => {
        const color = pullRequestLabelColor(label.color)
        return (
          <View key={label.name} className="flex-row items-center gap-1.5 rounded-full bg-grouped-card px-3 py-1">
            {color ? <View className="size-2 rounded-full" style={{ backgroundColor: color }} /> : null}
            <Text className="text-2xs text-foreground-muted">{label.name}</Text>
          </View>
        )
      })}
      {view.permissions.canManageLabels ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit labels"
          onPress={() => navigation.navigate('PullRequestLabels', view.ref)}
          className="min-h-8 flex-row items-center gap-1 rounded-full px-2 active:opacity-60"
        >
          <SymbolView name="pencil" size={12} tintColorClassName="accent-icon-muted" />
          <Text className="text-2xs font-t3-medium text-foreground-muted">{labels.length ? 'Edit labels' : 'Add labels'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** The GitHub stack, bottom to top; a layer opens its own pull request. */
function PullRequestStackCard({ view }: { readonly view: PullRequestView }) {
  const app = useApp()
  const navigation = useNavigation<Navigation>()
  const [expanded, setExpanded] = useState(false)
  const stack = view.detail.stack
  if (!stack) return null
  const position = stack.layers.findIndex((layer) => layer.number === view.pr.number) + 1
  return (
    <PullRequestCardGroup>
      <PullRequestCardRow
        title="Stack"
        icon="square.3.layers.3d"
        value={position > 0 ? `${position} of ${stack.layers.length}` : `${stack.layers.length} layers`}
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        last={!expanded}
      />
      {expanded ? (
        <View>
          {stack.layers.map((layer, index) => {
            const selected = layer.number === view.pr.number
            const status = pullRequestStatus(layer)
            return (
              <View key={layer.number} className={selected ? 'bg-thread-selected' : undefined}>
                <PullRequestCardRow
                  title={layer.title || layer.headRef}
                  icon={status.icon}
                  tint={status.tint}
                  value={selected ? 'Current' : status.label}
                  detail={`#${layer.number} · ${index + 1} of ${stack.layers.length}`}
                  {...(selected ? {} : { onPress: () => navigation.push('PullRequest', { ...view.ref, number: layer.number }) })}
                />
              </View>
            )
          })}
          <PullRequestCardRow title="Open stack on GitHub" icon="arrow.up.right" last onPress={() => void app.platform.openBrowser(stack.url)} />
          <Text className="px-4 pb-3 text-xs text-foreground-muted">Base: {stack.base}. Open a layer to review it, or to merge the stack through that layer.</Text>
        </View>
      ) : null}
    </PullRequestCardGroup>
  )
}

/** The changed files; a file opens the diff at that file. The heading folds the list. */
function ChangedFilesSummary({ view, onOpenFile }: { readonly view: PullRequestView; readonly onOpenFile: (path: string) => void }) {
  const [expanded, setExpanded] = useState(true)
  const files = view.detail.files
  const count = view.pr.changedFiles ?? files.length
  return (
    <View className="gap-3 border-t border-border-subtle pt-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Changed files, ${count} ${count === 1 ? 'file' : 'files'}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center gap-2 active:opacity-70"
      >
        <View className="min-w-0 flex-1 gap-1">
          <PullRequestSectionHeading>Changed files</PullRequestSectionHeading>
          <Text className="text-2xs text-foreground-muted">{count} {count === 1 ? 'file' : 'files'}</Text>
        </View>
        <PullRequestDiffStats additions={view.pr.additions} deletions={view.pr.deletions} compact />
        <SymbolView name={expanded ? 'chevron.up' : 'chevron.down'} size={11} tintColorClassName="accent-icon-muted" />
      </Pressable>
      {!expanded ? null : files.length === 0 ? (
        <Text className="text-sm text-foreground-muted">{view.detail.reading?.includes('files') ? 'Reading the changed files…' : view.detail.missing.includes('files') ? 'The host could not read the changed files.' : 'No changed files.'}</Text>
      ) : files.map((file) => {
        const slash = file.path.lastIndexOf('/')
        return (
          <Pressable
            key={file.path}
            accessibilityRole="button"
            accessibilityLabel={`View diff for ${file.path}, ${file.additions} additions, ${file.deletions} deletions`}
            onPress={() => onOpenFile(file.path)}
            className="min-h-12 flex-row items-center gap-3 border-b border-border-subtle py-2.5 active:opacity-70"
          >
            <SymbolView name="doc" size={16} tintColorClassName="accent-icon-muted" />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-t3-medium" numberOfLines={1}>{file.path.slice(slash + 1)}</Text>
              {slash > 0 ? <Text className="text-2xs text-foreground-muted" numberOfLines={1}>{file.path.slice(0, slash)}</Text> : null}
            </View>
            <PullRequestDiffStats additions={file.additions} deletions={file.deletions} compact />
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        )
      })}
    </View>
  )
}
