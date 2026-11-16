import { describe, expect, test } from 'bun:test'
import { configValueText, modelSettingOptions } from '@solus/client-core/app-config'
import { appConfigValueProblem, appDescriptorSchema, appModelCallName, parseAppCallName, resolveAppConfig } from '@solus/contracts/apps'
import type { AgentMetadata } from '@solus/contracts/types'

/**
 * The model setting of an app (docs/plans/app-models.md §4): a config field
 * whose value is a model id, set on the Manage page of desktop, web, and
 * mobile, and read by `ctx.models`. These are the rules every side shares.
 */

const descriptor = appDescriptorSchema.parse({
  solusApp: 3, name: 'CI', description: '',
  config: [{ name: 'analyst', label: 'Analyst', type: 'model' }],
})
const analyst = descriptor.config[0]

describe('the model setting', () => {
  test('a field with no default is Solus\'s default model, and the owner sets a model id', () => {
    // WHY: an app works before the owner chooses a model; the empty value means "the model Solus writes with".
    expect(analyst).toMatchObject({ type: 'model', default: '' })
    expect(resolveAppConfig(descriptor.config, {})).toEqual({ analyst: '' })
    expect(resolveAppConfig(descriptor.config, { analyst: 'claude-opus-5-5' })).toEqual({ analyst: 'claude-opus-5-5' })
    expect(appConfigValueProblem(analyst, 3)).toBe('Analyst takes a model id.')
    expect(configValueText(analyst, '')).toBe('Solus default')
  })

  test('the picker offers the default and each model the host runs, and keeps a saved model the host lost', () => {
    // WHY: a select that drops the saved value would show the default while the app still asks for another model.
    const agents: AgentMetadata[] = [
      { id: 'claude-code', label: 'Claude', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }] },
      { id: 'codex', label: 'Codex', models: [{ id: 'gpt-x', label: 'GPT X' }], available: false },
    ]
    expect(modelSettingOptions(agents, '')).toEqual([
      { value: '', label: 'Solus default' },
      { value: 'claude-opus-5-5', label: 'Claude · Opus 5.5' },
    ])
    expect(modelSettingOptions(agents, 'gpt-x').at(-1)).toEqual({ value: 'gpt-x', label: 'gpt-x (not on this host)' })
  })
})

test('a UI reaches its model calls by their own call names', () => {
  expect(parseAppCallName(appModelCallName('get'))).toEqual({ kind: 'models', operation: 'get' })
  expect(parseAppCallName(appModelCallName('cancel'))).toEqual({ kind: 'models', operation: 'cancel' })
  expect(parseAppCallName('@models/start')).toBeNull()
})
