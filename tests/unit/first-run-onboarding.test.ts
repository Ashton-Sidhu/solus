import { describe, expect, test } from 'bun:test'
import {
  ONBOARDING_GESTURES,
  ONBOARDING_KEYS,
  POINTER_STAGES,
  TOUCH_STAGES,
  WEB_ONBOARDING_KEYS,
  onboardingKeysFor,
  nextStage,
  previousStage,
  stagesFor,
  surfaceFor,
  type OnboardingStage,
  type OnboardingSurface,
} from '@solus/workspace-ui/components/onboarding/lib/onboarding-model'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'

const SURFACES: OnboardingSurface[] = ['pointer', 'touch']


describe('first-run onboarding stages', () => {
  test('the start choice is last, because answering it ends the flow', () => {
    // Everything before it is a question the workspace does not wait on. The
    // start choice is the one that decides where the user lands, so nothing may
    // be inserted after it.
    expect(POINTER_STAGES).toEqual(['shortcuts', 'agents', 'providers', 'start'])
    expect(POINTER_STAGES.at(-1)).toBe('start')
    expect(TOUCH_STAGES.at(-1)).toBe('start')
  })

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

  test('what to learn comes before any sign-in', () => {
    // The keys — or the gestures — are worth learning before a sign-in sends the
    // user away to a browser; once auth starts, nobody reads a shortcut card.
    const pointer = POINTER_STAGES as OnboardingStage[]
    expect(pointer.indexOf('shortcuts')).toBeLessThan(pointer.indexOf('agents'))
    expect(pointer.indexOf('shortcuts')).toBeLessThan(pointer.indexOf('providers'))
    const touch = TOUCH_STAGES as OnboardingStage[]
    expect(touch.indexOf('getting-around')).toBeLessThan(touch.indexOf('host'))
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

  test('the touch flow never teaches keys and never asks twice about a host', () => {
    // A thumb cannot press ⌘K, so `shortcuts` has nothing to offer it. `agents`
    // and `providers` are two screens asking about a machine the phone is not,
    // and which is usually already set up from its own desktop, so they collapse
    // into one `host` stage that reports rather than asks.
    expect(TOUCH_STAGES).not.toContain('shortcuts')
    expect(TOUCH_STAGES).not.toContain('agents')
    expect(TOUCH_STAGES).not.toContain('providers')
    expect(TOUCH_STAGES).toContain('host')
  })
})

describe('the getting-around stage', () => {
  test('it teaches as many gestures as its title promises', () => {
    // The stage's title reads "Four ways around".
    expect(ONBOARDING_GESTURES).toHaveLength(4)
  })

  test('every gesture names a distinct mark the stage can draw', () => {
    // The stage indexes its icon table by glyph: a repeated glyph means two rows
    // draw the same mark, and one outside the table fails to compile.
    const glyphs = ONBOARDING_GESTURES.map((gesture) => gesture.glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
    expect([...glyphs].sort()).toEqual(['back', 'plus', 'swipe', 'tap'])
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

  test('web teaches browser-safe task and session actions it implements', () => {
    // WHY: first-run web users need the actual task workflow, not desktop-only
    // Pill mode or command-palette guidance.
    expect(onboardingKeysFor(true)).toBe(WEB_ONBOARDING_KEYS)
    expect(WEB_ONBOARDING_KEYS.map((key) => key.id)).toEqual([
      'global.new-task',
      'global.new-session',
      'global.new-session-without-task',
      'global.select-project',
      'global.session-picker',
      'global.toggle-diff-panel',
      'global.toggle-workspace',
    ])

    for (const key of WEB_ONBOARDING_KEYS) {
      expect(KEYBINDINGS[key.id].scope).toBe('global')
      const binding = KEYBINDINGS[key.id]
      const webCombo = 'web' in binding ? binding.web : binding.combo
      expect(webCombo).not.toBeNull()
      expect(webCombo).not.toHaveProperty('mod', true)
      expect(webCombo).not.toHaveProperty('meta', true)
      expect(webCombo).not.toHaveProperty('ctrl', true)
    }

    const combos = WEB_ONBOARDING_KEYS.map((key) => {
      const binding = KEYBINDINGS[key.id]
      return JSON.stringify('web' in binding ? binding.web : binding.combo)
    })
    expect(new Set(combos).size).toBe(combos.length)
  })
})
