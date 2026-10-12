import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from 'react'
import { Alert, ScrollView, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { isDeviceRunActive, type DeviceRun } from '@solus/contracts/device-types'
import { formatRunElapsed, readRunLog, type RunLogLine } from '@solus/client-core/device-run-log'
import { useApp } from '../../app/app-context'
import { SymbolView } from '../../components/AppSymbol'
import { AppText as Text } from '../../components/AppText'
import { ControlPill } from '../../components/ControlPill'
import { ErrorBanner } from '../../components/ErrorBanner'
import { SegmentedControl } from '../../components/SegmentedControl'
import { cn } from '../../lib/cn'
import type { ScreenProps } from '../../navigation/routes'
import { CODE_FONT } from '../../theme/tokens'
import { HostStatusBanner } from '../hosts/HostStatusBanner'
import { deviceErrorText, useDeviceState } from './use-device-state'

type LogView = 'steps' | 'issues' | 'raw'

/**
 * One build's log on a phone (plan 016, S02), as the workspace shows it: the
 * stage, the current step and the time; then the steps, only the issues, or
 * the raw output. It reads the log once a second while the build runs and
 * the screen is in view. A failed build with errors opens on its issues.
 */
export function BuildLogScreen({ navigation, route }: ScreenProps<'BuildLog'>) {
  const { hostId, runId } = route.params
  const app = useApp()
  const { view: deviceView } = useDeviceState(hostId)
  const run = deviceView.kind === 'loaded' ? deviceView.state.runs.find((candidate) => candidate.runId === runId) : undefined
  const isActive = !!run && isDeviceRunActive(run)
  const [text, setText] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [chosenView, setChosenView] = useState<LogView | null>(null)
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null)

  useLayoutEffect(() => {
    if (run) navigation.setOptions({ title: run.profileName })
  }, [navigation, run?.profileName])

  const read = useCallback(() => {
    const connection = app.connections.connection(hostId)
    if (!connection) return
    connection.api.deviceRunLog(runId).then(
      (log) => {
        const lines = log.text.split('\n')
        setText(lines.slice(-400).join('\n'))
        setTruncated(log.truncated || lines.length > 400)
        setReadError(null)
        setNow(Date.now())
      },
      (cause: unknown) => setReadError(deviceErrorText(cause)),
    )
  }, [app, hostId, runId])

  // Once when it opens or the build ends; every second while it builds and the screen is in view.
  useEffect(() => { read() }, [read, isActive])
  useFocusEffect(useCallback(() => {
    if (!isActive) return
    const timer = setInterval(read, 1_000)
    return () => clearInterval(timer)
  }, [isActive, read]))

  const steps = readRunLog(text)
  const issues = steps.filter((step) => step.tone === 'error' || step.tone === 'warning')
  const errors = issues.filter((step) => step.tone === 'error').length
  const view: LogView = steps.length === 0 ? 'raw' : (chosenView ?? (run?.stage === 'failed' && errors > 0 ? 'issues' : 'steps'))
  const shown = view === 'issues' ? issues : steps
  const currentStep = steps.findLast((step) => step.tone === 'step')

  const cancel = () => {
    app.connections.connection(hostId)?.api.deviceRunCancel(runId).catch((cause: unknown) => Alert.alert('Could not cancel the build', deviceErrorText(cause)))
  }

  return (
    <View className="flex-1 bg-sheet">
      <View className="gap-3 px-4 pt-2 pb-3">
        <HostStatusBanner hostId={hostId} />
        {run ? <RunSummary run={run} now={now} currentStep={currentStep} onCancel={cancel} /> : null}
        {readError ? <ErrorBanner message={`The log could not be read: ${readError}`} /> : null}
        <SegmentedControl
          options={[{ value: 'steps', label: 'Steps' }, { value: 'issues', label: issues.length ? `Issues (${issues.length})` : 'Issues' }, { value: 'raw', label: 'Raw' }]}
          selected={view}
          onSelect={setChosenView}
        />
      </View>
      <ScrollView
        ref={scroll}
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        // Follow new output, as a terminal does.
        onContentSizeChange={() => { if (isActive) scroll.current?.scrollToEnd({ animated: false }) }}
      >
        {truncated ? <Text className="pb-2 text-xs text-foreground-tertiary">Earlier output is not kept.</Text> : null}
        <LogBody text={text} view={view} shown={shown} isActive={isActive} />
      </ScrollView>
    </View>
  )
}

/** The build's stage, current step, time and error, with Cancel while it builds. */
function RunSummary(props: { readonly run: DeviceRun; readonly now: number; readonly currentStep: RunLogLine | undefined; readonly onCancel: () => void }) {
  const { run, now, currentStep } = props
  const isActive = isDeviceRunActive(run)
  const title = isActive ? `Building ${run.profileName}...` : run.stage === 'failed' ? `${run.profileName} failed` : `${run.profileName} is built`
  const detail = (isActive && currentStep ? [currentStep.text, currentStep.target] : [run.checkout, run.branch]).filter(Boolean).join(' · ')
  return (
    <View className="gap-1 rounded-[20px] bg-grouped-card px-4 py-3" accessibilityLiveRegion="polite">
      <View className="flex-row items-center gap-2">
        <Text className={cn('min-w-0 flex-1 text-base font-t3-bold leading-snug', run.stage === 'failed' ? 'text-danger-foreground' : 'text-foreground')} numberOfLines={1}>{title}</Text>
        <Text className="text-xs text-foreground-tertiary">{formatRunElapsed((run.endedAt ?? now) - run.startedAt)}</Text>
      </View>
      {detail ? <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>{detail}</Text> : null}
      {run.error ? <Text className="pt-1 text-sm text-danger-foreground">{run.error}</Text> : null}
      {isActive ? (
        <View className="flex-row pt-1.5">
          <ControlPill variant="pill" label="Cancel" accessibilityLabel={`Cancel ${run.profileName}`} onPress={props.onCancel} />
        </View>
      ) : null}
    </View>
  )
}

/** The log as steps, only its issues, or the raw output. */
function LogBody(props: { readonly text: string; readonly view: LogView; readonly shown: readonly RunLogLine[]; readonly isActive: boolean }) {
  const { text, view, shown, isActive } = props
  if (!text) return <Text className="text-sm text-foreground-muted">{isActive ? 'Waiting for output...' : 'No output.'}</Text>
  if (view === 'raw') return <Text selectable className="text-xs leading-relaxed text-foreground-muted" style={{ fontFamily: CODE_FONT }}>{text}</Text>
  if (shown.length === 0) return <Text className="text-sm text-foreground-muted">No errors or warnings{isActive ? ' yet' : ''}.</Text>
  return (
    <View className="gap-1.5">
      {shown.map((step, index) => (
        <View key={index} className="flex-row items-start gap-2">
          {step.tone === 'error' || step.tone === 'warning' ? (
            <SymbolView name={step.tone === 'error' ? 'xmark.circle.fill' : 'exclamationmark.triangle'} size={13} tintColorClassName={step.tone === 'error' ? 'accent-danger' : 'accent-warning'} type="monochrome" />
          ) : null}
          <Text selectable className={cn('min-w-0 flex-1 text-sm', step.tone === 'error' ? 'text-danger-foreground' : step.tone === 'warning' ? 'text-warning-foreground' : 'text-foreground-muted')}>{step.text}</Text>
          {step.target ? <Text className="max-w-[40%] text-xs text-foreground-tertiary" numberOfLines={1}>{step.target}</Text> : null}
        </View>
      ))}
    </View>
  )
}
