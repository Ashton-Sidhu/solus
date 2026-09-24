import { describe, expect, test } from 'bun:test'
import {
  nextStage,
  previousStage,
  stagesFor,
  surfaceFor,
  type OnboardingSurface,
} from '@solus/workspace-ui/components/onboarding/lib/onboarding-model'

const SURFACES: OnboardingSurface[] = ['pointer', 'touch']


describe('first-run onboarding stages', () => {
  test('naming a new project and choosing existing code are steps inside the flow, never stages the order walks into', () => {
    // WHY: "Start something new" asks for a name, and "Open existing code" for
    // a folder, before the flow ends. Continue on the last listed stage must
    // still end the flow, and no Continue may land on either step without the
    // start choice that opens it.
    for (const surface of SURFACES) {
      for (const flow of ['host', 'cloud'] as const) {
        expect(stagesFor(surface, flow)).not.toContain('name-project')
        expect(stagesFor(surface, flow)).not.toContain('open-project')
      }
    }
  })

  test('the greeting leads into the first question and is never returned to', () => {
    expect(nextStage('intro', 'pointer')).toBe('agents')
    expect(previousStage('agents', 'pointer')).toBeNull()
    // 'intro' is not an asking stage, so it has no position to step back from.
    expect(previousStage('intro', 'pointer')).toBeNull()
  })

  test('every stage runs forward into the next one', () => {
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
      for (const offersCloudConnect of [true, false]) {
        expect(stagesFor(surface).at(-1)).toBe('start')
        expect(nextStage('start', surface, 'host', { offersCloudConnect })).toBeNull()
      }
    }
  })

  test('where the shell holds an account, the Solus Cloud offer comes just before the choice of where to start', () => {
    // WHY: the flow must end on "How do you want to start?", because that
    // answer opens the workspace. An account step after it would hold the user
    // on onboarding after they had chosen where to work.
    const withCloud = { offersCloudConnect: true }
    expect(nextStage('providers', 'pointer', 'host', withCloud)).toBe('cloud-connect')
    expect(nextStage('cloud-connect', 'pointer', 'host', withCloud)).toBe('start')
    expect(previousStage('start', 'pointer', 'host', withCloud)).toBe('cloud-connect')
    expect(nextStage('host', 'touch', 'host', withCloud)).toBe('cloud-connect')
  })

  test('without an account to connect, the Solus Cloud offer is never shown', () => {
    // The web and mobile shells hold no account: the offer would be a dead end.
    for (const surface of SURFACES) {
      const beforeStart = surface === 'touch' ? 'host' : 'providers'
      expect(nextStage(beforeStart, surface)).toBe('start')
      expect(previousStage('start', surface)).toBe(beforeStart)
    }
  })

  test('back and forward are inverses across every asking stage', () => {
    for (const surface of SURFACES) {
      for (const offersCloudConnect of [true, false]) {
        const conditions = { offersCloudConnect }
        const shown = stagesFor(surface).filter((stage) => offersCloudConnect || stage !== 'cloud-connect')
        for (const stage of shown) {
          const next = nextStage(stage, surface, 'host', conditions)
          if (!next) continue
          expect(previousStage(next, surface, 'host', conditions)).toBe(stage)
        }
        // The greeting is not a place to return to, on either flow.
        expect(previousStage(shown[0], surface, 'host', conditions)).toBeNull()
      }
    }
  })
})

describe('cloud onboarding stages', () => {
  test('a cloud account asks for a machine, its agents, GitHub, then a project', () => {
    expect(nextStage('intro', 'pointer', 'cloud')).toBe('compute')
    expect(nextStage('compute', 'pointer', 'cloud')).toBe('agents')
    expect(nextStage('agents', 'pointer', 'cloud')).toBe('github')
    expect(nextStage('github', 'pointer', 'cloud')).toBe('project')
    expect(nextStage('project', 'pointer', 'cloud')).toBeNull()
    expect(nextStage('intro', 'touch', 'cloud')).toBe('getting-around')
    expect(nextStage('getting-around', 'touch', 'cloud')).toBe('compute')
  })

  test('with no machine chosen there are no agents to ask about, in either direction', () => {
    // The workspace service runs no agents; asking it is what failed before.
    for (const surface of SURFACES) {
      expect(nextStage('compute', surface, 'cloud', { skipsAgents: true })).toBe('github')
      expect(previousStage('github', surface, 'cloud', { skipsAgents: true })).toBe('compute')
    }
  })

  test('the host flow never shows a cloud stage', () => {
    for (const surface of SURFACES) {
      for (const stage of ['compute', 'github', 'project'] as const) {
        expect(stagesFor(surface, 'host')).not.toContain(stage)
      }
    }
  })

  test('the cloud flow never offers to connect to Solus Cloud', () => {
    // It is already signed in to Solus Cloud.
    for (const surface of SURFACES) {
      expect(stagesFor(surface, 'cloud')).not.toContain('cloud-connect')
    }
  })
})

describe('choosing a surface', () => {
  test('only a device with no precise pointer gets the touch flow', () => {
    // Not desktop-versus-web. A browser on a laptop has the same keyboard and
    // the same room as the desktop app, so it gets the pointer flow; an iPad
    // with a Magic Keyboard reports a fine pointer and gets it too. What the
    // flow branches on is whether there is anything to press.
    expect(surfaceFor({ isTouchDevice: true, hasKeyboardPointer: false })).toBe('touch')
    expect(surfaceFor({ isTouchDevice: true, hasKeyboardPointer: true })).toBe('pointer')
    expect(surfaceFor({ isTouchDevice: false, hasKeyboardPointer: true })).toBe('pointer')
  })
})
