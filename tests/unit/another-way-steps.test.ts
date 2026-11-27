import { describe, expect, test } from 'bun:test'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'
import { anotherWaySteps } from '@solus/workspace-ui/components/connections/lib/another-way-steps'

// WHY: docs/outside-apps.md, "Set up another way". The page listed an address,
// a message, numbered steps, a help link, the access, and a code as separate
// blocks, and a person could not tell what to do first. It is now one
// timeline: the app's own steps, with the address or the message on the step
// that uses it, then the code, then the sign-in. Only what Solus can see moves
// it: a copy of the address or the message, and the app's sign-in.

const guide = (id: string) => OUTSIDE_APP_GUIDES.find((candidate) => candidate.id === id)!

describe('Set up another way as a timeline', () => {
  test("the address goes on the app's step that says to paste it, then the code, then the sign-in", () => {
    const steps = anotherWaySteps(guide('claude'), false, { copied: null, hasSignedIn: false })
    expect(steps.map((step) => [step.title, step.attachment, step.state])).toEqual([
      ['In Claude, open Customize, then Connectors.', null, 'current'],
      ['Choose Add custom connector and paste the address.', 'address', 'next'],
      ['When Claude asks for a code, enter this one', 'code', 'next'],
      ['Claude signs in', null, 'next'],
    ])
    // The app's note is beside the address it is about.
    expect(steps[1]!.hint).toBe('The Free plan allows one custom connector.')
  })

  test('an app set up by a message carries the message, and copying it moves the timeline to the code', () => {
    const before = anotherWaySteps(guide('muse'), true, { copied: null, hasSignedIn: false })
    expect(before.map((step) => step.attachment)).toEqual(['message', 'code', null])
    const after = anotherWaySteps(guide('muse'), true, { copied: 'message', hasSignedIn: false })
    expect(after.map((step) => step.state)).toEqual(['done', 'current', 'next'])
    // Copying the address of an app that needs the message is not its step.
    expect(anotherWaySteps(guide('muse'), true, { copied: 'address', hasSignedIn: false })[0]!.state).toBe('current')
  })

  test('the sign-in marks every step done', () => {
    const steps = anotherWaySteps(guide('claude'), false, { copied: null, hasSignedIn: true })
    expect(steps.every((step) => step.state === 'done')).toBe(true)
  })

  test('another MCP app gets the general step with the address', () => {
    const steps = anotherWaySteps(null, false, { copied: 'address', hasSignedIn: false })
    expect(steps.map((step) => [step.title, step.state])).toEqual([
      ['Add a remote MCP server with OAuth, and paste the address.', 'done'],
      ['When the app asks for a code, enter this one', 'current'],
      ['The app signs in', 'next'],
    ])
  })
})
