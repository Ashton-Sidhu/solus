import { describe, expect, test } from 'bun:test'
import {
  ONBOARDING_KEYS,
  ONBOARDING_STAGES,
  nextStage,
  previousStage,
  type OnboardingStage,
} from '../../src/renderer/components/onboarding/lib/onboarding-model'
import { KEYBINDINGS } from '../../src/renderer/lib/keybindings/manifest'

describe('first-run onboarding stages', () => {
  test('the start choice is last, because answering it ends the flow', () => {
    // Everything before it is a question the workspace does not wait on. The
    // start choice is the one that decides where the user lands, so nothing may
    // be inserted after it.
    expect(ONBOARDING_STAGES).toEqual(['shortcuts', 'agents', 'providers', 'start'])
    expect(ONBOARDING_STAGES.at(-1)).toBe('start')
  })

  test('the greeting leads into the first question and is never returned to', () => {
    expect(nextStage('intro')).toBe('shortcuts')
    expect(previousStage('shortcuts')).toBeNull()
    // 'intro' is not an asking stage, so it has no position to step back from.
    expect(previousStage('intro')).toBeNull()
  })

  test('every stage runs forward into the next one', () => {
    expect(nextStage('shortcuts')).toBe('agents')
    expect(nextStage('agents')).toBe('providers')
    expect(nextStage('providers')).toBe('start')
  })

  test('the last stage reports the end of the flow rather than another stage', () => {
    // The surface finishes on null. Returning a stage here would loop the user
    // back into onboarding after they had already chosen where to land.
    expect(nextStage('start')).toBeNull()
  })

  test('back and forward are inverses across every asking stage', () => {
    for (const stage of ONBOARDING_STAGES) {
      const next = nextStage(stage)
      if (!next) continue
      expect(previousStage(next)).toBe(stage)
    }
  })

  test('shortcuts come before any sign-in', () => {
    // The keys are worth learning before a sign-in sends the user away to a
    // browser — once auth starts, nobody reads a shortcut card.
    const order = ONBOARDING_STAGES as OnboardingStage[]
    expect(order.indexOf('shortcuts')).toBeLessThan(order.indexOf('agents'))
    expect(order.indexOf('shortcuts')).toBeLessThan(order.indexOf('providers'))
  })
})

describe('the shortcuts stage', () => {
  test('every key it teaches is a binding the app actually answers to', () => {
    // A card printing a combo with no binding behind it is a lie the user only
    // discovers after onboarding is gone.
    expect(ONBOARDING_KEYS).toHaveLength(7)
    for (const key of ONBOARDING_KEYS) {
      expect(KEYBINDINGS[key.id]).toBeDefined()
      expect(KEYBINDINGS[key.id].scope).toBe('global')
    }
  })

  test('the editor/pill mode switch is taught', () => {
    // Editor mode is how the workspace is actually entered; a first-run user
    // who never learns the switch stays stuck in the pill.
    expect(ONBOARDING_KEYS.map((key) => key.id)).toContain('global.continue-in-mode')
  })
})
