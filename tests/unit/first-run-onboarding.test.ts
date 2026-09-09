import { describe, expect, test } from 'bun:test'
import {
  ONBOARDING_KEYS,
  onboardingKeysFor,
  nextStage,
  previousStage,
  stagesFor,
  surfaceFor,
  type OnboardingSurface,
} from '@solus/workspace-ui/components/onboarding/lib/onboarding-model'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'

const SURFACES: OnboardingSurface[] = ['pointer', 'touch']


describe('first-run onboarding stages', () => {
  test('the greeting leads into the first question and is never returned to', () => {
    expect(nextStage('intro', 'pointer')).toBe('shortcuts')
    expect(previousStage('shortcuts', 'pointer')).toBeNull()
    // 'intro' is not an asking stage, so it has no position to step back from.
    expect(previousStage('intro', 'pointer')).toBeNull()
  })

  test('every stage runs forward into the next one', () => {
    expect(nextStage('shortcuts', 'pointer')).toBe('agents')
    expect(nextStage('agents', 'pointer')).toBe('providers')
    expect(nextStage('providers', 'pointer')).toBe('start')
    expect(nextStage('intro', 'touch')).toBe('getting-around')
    expect(nextStage('getting-around', 'touch')).toBe('host')
    expect(nextStage('host', 'touch')).toBe('start')
  })

  test('the last stage reports the end of the flow rather than another stage', () => {
    // The surface finishes on null. Returning a stage here would loop the user
    // back into onboarding after they had already chosen where to land.
    for (const surface of SURFACES) {
      expect(stagesFor(surface).at(-1)).toBe('start')
      expect(nextStage('start', surface)).toBeNull()
    }
  })

  test('back and forward are inverses across every asking stage', () => {
    for (const surface of SURFACES) {
      for (const stage of stagesFor(surface)) {
        const next = nextStage(stage, surface)
        if (!next) continue
        expect(previousStage(next, surface)).toBe(stage)
      }
      // The greeting is not a place to return to, on either flow.
      expect(previousStage(stagesFor(surface)[0], surface)).toBeNull()
    }
  })
})

describe('choosing a surface', () => {
  test('only a device with no precise pointer gets the touch flow', () => {
    // Not desktop-versus-web. A browser on a laptop has the same keyboard and
    // the same room as the desktop app, so it keeps the keys; an iPad with a
    // Magic Keyboard reports a fine pointer and keeps them too. What the flow
    // branches on is whether there is anything to press.
    expect(surfaceFor({ isTouchDevice: true, hasKeyboardPointer: false })).toBe('touch')
    expect(surfaceFor({ isTouchDevice: true, hasKeyboardPointer: true })).toBe('pointer')
    expect(surfaceFor({ isTouchDevice: false, hasKeyboardPointer: true })).toBe('pointer')
  })
})

describe('the shortcuts stage', () => {
  test('every key it teaches is a binding the app actually answers to', () => {
    // A card printing a combo with no binding behind it is a lie the user only
    // discovers after onboarding is gone.
    expect(ONBOARDING_KEYS.length).toBeGreaterThan(0)
    for (const key of ONBOARDING_KEYS) {
      expect(KEYBINDINGS[key.id]).toBeDefined()
      expect(KEYBINDINGS[key.id].scope).toBe('global')
    }
  })

  test('web teaches browser-safe task and session actions it implements', () => {
    // WHY: first-run web users need the actual task workflow, not desktop-only
    // Pill mode or command-palette guidance.
    const keys = onboardingKeysFor(true)
    expect(keys.length).toBeGreaterThan(0)

    for (const key of keys) {
      expect(KEYBINDINGS[key.id].scope).toBe('global')
      const binding = KEYBINDINGS[key.id]
      const webCombo = 'web' in binding ? binding.web : binding.combo
      expect(webCombo).not.toBeNull()
      expect(webCombo).not.toHaveProperty('mod', true)
      expect(webCombo).not.toHaveProperty('meta', true)
      expect(webCombo).not.toHaveProperty('ctrl', true)
    }

    const combos = keys.map((key) => {
      const binding = KEYBINDINGS[key.id]
      return JSON.stringify('web' in binding ? binding.web : binding.combo)
    })
    expect(new Set(combos).size).toBe(combos.length)
  })
})
