import type { PersonalSettings, PersonalSettingsDocument } from '@solus/contracts/settings'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { modelChoices, PERMISSION_MODE_TEXT, PERMISSION_MODES, PROVIDERS } from '../conversation/lib/run-settings'
import { RATE_LIMIT_CHOICES, STREAMING_CHOICES } from './lib/settings-labels'
import { ChoiceRow, GroupedScroll, GroupedSection, SwitchRow } from '../../ui/grouped-rows'

/**
 * What a new session starts with and how its runs behave. These are the
 * person's own settings (plans/018): they follow them to every host, and to
 * every device when sync is on.
 */
export function AgentDefaultsScreen(_props: ScreenProps<'AgentDefaults'>) {
  const app = useApp()
  const settings = useListened(app.personal.changes, app.personal.current)
  const update = (patch: PersonalSettingsDocument) => { app.personal.set(patch) }

  const agent = settings.activeAgent
  const agentLabel = PROVIDERS.find((provider) => provider.id === agent)?.label ?? agent
  const defaultModel = settings.defaultModels[agent] ?? null
  // `defaultModels` is replaced as a whole, so the other agents' choices ride along.
  const setDefaultModel = (modelId: string | null) => {
    const next: PersonalSettings['defaultModels'] = { ...settings.defaultModels }
    if (modelId) next[agent] = modelId
    else delete next[agent]
    update({ defaultModels: next })
  }

  return (
    <GroupedScroll>
      <GroupedSection title="Default agent">
        {PROVIDERS.map((provider, index) => (
          <ChoiceRow key={provider.id} isFirst={index === 0} label={provider.label} selected={agent === provider.id} onPress={() => update({ activeAgent: provider.id })} />
        ))}
      </GroupedSection>

      <GroupedSection title={`Default model for ${agentLabel}`} footer="A session can still pick another model before its first prompt.">
        <ChoiceRow isFirst label="Built-in default" description={`The model ${agentLabel} uses when none is chosen.`} selected={defaultModel === null} onPress={() => setDefaultModel(null)} />
        {modelChoices(agent, defaultModel).map((model) => (
          <ChoiceRow key={model.id} isFirst={false} label={model.label} selected={defaultModel === model.id} onPress={() => setDefaultModel(model.id)} />
        ))}
      </GroupedSection>

      <GroupedSection title="Permissions" footer="How much a new session may do without asking you.">
        {PERMISSION_MODES.map((mode, index) => (
          <ChoiceRow
            key={mode}
            isFirst={index === 0}
            label={PERMISSION_MODE_TEXT[mode].label}
            description={PERMISSION_MODE_TEXT[mode].description}
            selected={settings.defaultPermissionMode === mode}
            onPress={() => update({ defaultPermissionMode: mode })}
          />
        ))}
      </GroupedSection>

      <GroupedSection title="Responses">
        {STREAMING_CHOICES.map((choice, index) => (
          <ChoiceRow key={choice.mode} isFirst={index === 0} label={choice.label} description={choice.description} selected={settings.responseStreamingMode === choice.mode} onPress={() => update({ responseStreamingMode: choice.mode })} />
        ))}
      </GroupedSection>

      <GroupedSection title="Rate limits" footer="What your runs do when they hit a provider rate limit.">
        {RATE_LIMIT_CHOICES.map((choice, index) => (
          <ChoiceRow key={choice.mode} isFirst={index === 0} label={choice.label} selected={settings.rateLimitBehavior === choice.mode} onPress={() => update({ rateLimitBehavior: choice.mode })} />
        ))}
      </GroupedSection>

      <GroupedSection title="Sessions">
        <SwitchRow icon="rename" label="Name sessions automatically" subtitle="Summarize the first prompt into a short session name." value={settings.autoRenameSessions} onChange={(next) => update({ autoRenameSessions: next })} />
      </GroupedSection>
    </GroupedScroll>
  )
}
