import { describe, expect, test } from 'bun:test'
import type { WorkerModelSelection } from '@solus/contracts/settings'
import {
  isWorkerModelChoiceSelected,
  workerModelAfterChoice,
  workerModelChoices,
} from '../../apps/mobile/solus-core/features/settings/worker-model-choices'

// WHY: the phone sets the same worker model and fallback model as desktop and
// web. The first row turns the setting off, the saved value always has a row,
// and a tap on the saved row keeps the reasoning level the person chose
// elsewhere instead of resetting it.

describe('mobile worker model choices', () => {
  test('the first row turns the setting off, and both providers follow', () => {
    const choices = workerModelChoices(null, 'No fallback')
    expect(choices[0]).toEqual({ key: 'off', label: 'No fallback', selection: null })
    expect(isWorkerModelChoiceSelected(choices[0]!, null)).toBe(true)
    const providers = new Set(choices.slice(1).map((choice) => choice.selection?.provider))
    expect([...providers]).toEqual(['claude-code', 'codex'])
  })

  test('a saved model that the list does not offer keeps its row', () => {
    const saved: WorkerModelSelection = { provider: 'codex', model: 'codex-retired-model', reasoningEffort: 'high' }
    const choices = workerModelChoices(saved, 'Off')
    expect(choices.filter((choice) => isWorkerModelChoiceSelected(choice, saved))).toHaveLength(1)
  })

  test('a tap on the saved row keeps its reasoning level; another row runs at the model default', () => {
    const choices = workerModelChoices(null, 'Off')
    const first = choices[1]!
    const saved: WorkerModelSelection = { ...first.selection!, reasoningEffort: 'max' }
    expect(workerModelAfterChoice(first, saved)).toBe(saved)
    const other = choices.find((choice) => choice.selection && !isWorkerModelChoiceSelected(choice, saved))!
    expect(workerModelAfterChoice(other, saved)?.reasoningEffort).toBeUndefined()
    expect(workerModelAfterChoice(choices[0]!, saved)).toBeNull()
  })
})
