import { useMemo, useState } from 'react'
import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { MaterialButton } from '../../components/MaterialButton'
import type { ScreenProps } from '../../navigation/routes'
import { AGENT_OFFLINE_REASON, usePullRequestAgent } from './detail/PullRequestAgentActions'
import { PullRequestSheetContent } from './detail/PullRequestSheetContent'
import { usePullRequestView } from './detail/use-pull-request-view'
import type { PullRequestView } from './detail/pull-request-view'

/**
 * A question to an agent about the pull request, from the main action of its
 * toolbar. The agent starts in a new session in the pull request's checkout,
 * and the session opens in place of this sheet.
 */
export function PullRequestAskScreen({ route }: ScreenProps<'PullRequestAsk'>) {
  const { hostId, projectPath, number } = route.params
  const ref = useMemo(() => ({ hostId, projectPath, number }), [hostId, projectPath, number])
  const { view } = usePullRequestView(ref)
  if (!view) {
    return (
      <PullRequestSheetContent title="Ask agent" subtitle={`#${number}`}>
        <Text className="text-sm text-foreground-muted">Loading pull request…</Text>
      </PullRequestSheetContent>
    )
  }
  return <AskForm view={view} />
}

function AskForm({ view }: { readonly view: PullRequestView }) {
  const agent = usePullRequestAgent(view)
  const [question, setQuestion] = useState('')
  const disabled = !agent.available || agent.busy
  return (
    <PullRequestSheetContent
      busy={agent.starting}
      title="Ask agent"
      subtitle={`#${view.pr.number} · ${view.pr.title}`}
      footer={
        <MaterialButton
          fullWidth
          tone="primary"
          label={agent.starting ? 'Starting…' : 'Ask'}
          loading={agent.starting}
          disabled={disabled || !question.trim()}
          onPress={() => void agent.start('ask', question)}
        />
      }
    >
      <TextInput
        multiline
        autoFocus
        editable={!disabled}
        accessibilityLabel="Question about this pull request"
        placeholder="Ask about this pull request…"
        placeholderTextColorClassName="accent-placeholder"
        maxLength={8000}
        value={question}
        onChangeText={setQuestion}
        className="min-h-32 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: 'top' }}
      />
      <Text className="text-xs text-foreground-muted">The agent works in a new session in a checkout of this pull request.</Text>
      {!agent.available ? <Text className="text-sm text-foreground-muted">{AGENT_OFFLINE_REASON}</Text> : null}
    </PullRequestSheetContent>
  )
}
