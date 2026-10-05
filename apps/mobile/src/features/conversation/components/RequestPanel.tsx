import { useState } from 'react'
import { Text, View } from 'react-native'
import { usePalette } from '../../../theme/theme'
import { radius, space, type } from '../../../theme/tokens'
import { Button } from '../../../ui/primitives'
import type { ConversationMeta, ConversationStore } from '../conversation-store'
import { questionKey } from '@solus/contracts/question-answer'
import { requestExpiryText } from '@solus/contracts/types'
import { AgentPlanCard } from './AgentPlanCard'
import type { PendingQuestion } from '../lib/transcript-model'

/**
 * What the agent waits on: permission and question cards, a rate limit, and
 * queued prompts. A card leaves when the host resolves the request, whether
 * this device or another one answered it.
 */
export function RequestPanel({ store, meta }: { store: ConversationStore; meta: ConversationMeta }) {
  const palette = usePalette()
  const [sending, setSending] = useState<string | null>(null)
  const answer = async (questionId: string, call: () => Promise<boolean>) => {
    setSending(questionId)
    try { await call() } finally { setSending(null) }
  }
  if (!meta.permissions.length && !meta.questions.length && !meta.rateLimit && !meta.queued.length && !meta.agentPlans.length) return null
  return (
    <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
      {meta.agentPlans.map((plan) => <AgentPlanCard key={`${plan.targetSessionId}:${plan.messageId}`} store={store} plan={plan} />)}
      {meta.permissions.map((request) => (
        <View key={request.questionId} accessibilityRole="alert" style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: palette.accent, backgroundColor: palette.card, padding: space.md, gap: space.sm }}>
          <Text style={{ color: palette.text, fontSize: type.chrome, fontWeight: '600' }}>Allow {request.toolName}?</Text>
          {request.description ? <Text numberOfLines={4} style={{ color: palette.textSecondary, fontSize: type.dense }}>{request.description}</Text> : null}
          {request.expired ? <Text style={{ color: palette.textSecondary, fontSize: type.dense }}>{requestExpiryText(request.expired)}</Text> : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {request.options.map((option) => (
              <Button
                key={option.id}
                label={option.label}
                tone={option.kind === 'deny' || option.kind?.startsWith('reject') ? 'secondary' : 'primary'}
                busy={sending === request.questionId}
                onPress={() => void answer(request.questionId, () => store.controller.answerPermission(request.questionId, option.id))}
              />
            ))}
          </View>
          )}
        </View>
      ))}
      {meta.questions.map((question) => (
        <QuestionCard key={question.questionId} question={question} busy={sending === question.questionId} onAnswer={(answers) => void answer(question.questionId, () => store.controller.answerQuestion(question.questionId, answers))} />
      ))}
      {meta.rateLimit ? (
        <View accessibilityRole="alert" style={{ borderRadius: radius.lg, backgroundColor: palette.dangerSoft, padding: space.md, gap: space.sm }}>
          <Text style={{ color: palette.text, fontSize: type.chrome, fontWeight: '600' }}>Usage limit reached</Text>
          <Text style={{ color: palette.textSecondary, fontSize: type.dense }}>
            {meta.rateLimit.resetsAt ? `It resets at ${new Date(meta.rateLimit.resetsAt * 1000).toLocaleTimeString()}.` : 'No reset time is known.'}
          </Text>
          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            <Button label="Wait" onPress={() => void store.controller.rateLimitDecision('wait')} />
            <Button label="Send now" onPress={() => void store.controller.rateLimitDecision('send_now')} />
            <Button tone="danger" label="Stop" onPress={() => void store.controller.rateLimitDecision('stop')} />
          </View>
        </View>
      ) : null}
    </View>
  )
}

function QuestionCard({ question, busy, onAnswer }: { question: PendingQuestion; busy: boolean; onAnswer: (answers: Record<string, string>) => void }) {
  const palette = usePalette()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  // Keyed as the host reads them (`questionKey`): the question's id, else its text.
  const complete = question.questions.every((item) => answers[questionKey(item)])
  return (
    <View accessibilityRole="alert" style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: palette.accent, backgroundColor: palette.card, padding: space.md, gap: space.md }}>
      {question.questions.map((item) => {
        const key = questionKey(item)
        const chosen = (answers[key] ?? '').split(', ').filter(Boolean)
        return (
          <View key={key} style={{ gap: space.sm }}>
            <Text style={{ color: palette.text, fontSize: type.chrome, fontWeight: '600' }}>{item.question}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {item.options.map((option) => {
                const selected = chosen.includes(option.label)
                return (
                  <Button
                    key={option.label}
                    label={selected ? `✓ ${option.label}` : option.label}
                    tone={selected ? 'primary' : 'secondary'}
                    accessibilityHint={option.description}
                    disabled={!!question.expired}
                    onPress={() => {
                      const next = item.multiSelect
                        ? (selected ? chosen.filter((label) => label !== option.label) : [...chosen, option.label]).join(', ')
                        : option.label
                      setAnswers({ ...answers, [key]: next })
                    }}
                  />
                )
              })}
            </View>
          </View>
        )
      })}
      {question.expired
        ? <Text style={{ color: palette.textSecondary, fontSize: type.dense }}>{requestExpiryText(question.expired)}</Text>
        : <Button tone="primary" label="Answer" busy={busy} disabled={!complete} onPress={() => onAnswer(answers)} />}
    </View>
  )
}
