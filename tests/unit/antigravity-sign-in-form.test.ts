import { describe, expect, test } from 'bun:test'
import { signInCodeFlowOf, signInSteps } from '@solus/client-core/sign-in-steps'
import { antigravityActionOf } from '@solus/workspace-ui/components/seats/lib/antigravity-sign-in'

const form = { method: 'oauth-personal' as const, gcpProject: '', gcpLocation: 'global', credential: '' }

describe('the Antigravity sign-in form', () => {
  test('a Google account signs in at once; Gemini Enterprise first needs its Google Cloud project', () => {
    expect(antigravityActionOf(form)).toEqual({ kind: 'browser', signIn: { method: 'oauth-personal' } })
    expect(antigravityActionOf({ ...form, method: 'oauth-business' })).toEqual({ kind: 'incomplete', message: null })
    expect(antigravityActionOf({ ...form, method: 'oauth-business', gcpProject: 'my-project-123' }))
      .toEqual({ kind: 'browser', signIn: { method: 'oauth-business', gcpProject: 'my-project-123', gcpLocation: 'global' } })
  })

  test('a project id the host would refuse is named before anything is sent', () => {
    const action = antigravityActionOf({ ...form, method: 'oauth-business', gcpProject: 'My Project' })
    expect(action).toEqual({ kind: 'incomplete', message: 'Enter a Google Cloud project id, such as my-project-123.' })
  })

  test('a pasted credential is saved with what it is: a Gemini key, or Vertex AI with its project', () => {
    expect(antigravityActionOf({ ...form, method: 'gemini-api-key', credential: ' AIza-key ' }))
      .toEqual({ kind: 'credential', token: 'AIza-key', credential: { method: 'gemini-api-key' } })
    expect(antigravityActionOf({ ...form, method: 'agent-platform', gcpProject: 'my-project-123', credential: 'AIza-key' }))
      .toEqual({ kind: 'credential', token: 'AIza-key', credential: { method: 'agent-platform', gcpProject: 'my-project-123', gcpLocation: 'global' } })
    expect(antigravityActionOf({ ...form, method: 'gemini-api-key' })).toEqual({ kind: 'incomplete', message: null })
  })
})

describe('the sign-in steps of a Gemini Enterprise sign-in', () => {
  test('ask for the address the browser ends on, not a code', () => {
    const flow = signInCodeFlowOf({ verificationUrl: 'https://accounts.google.com/x', requiresCodeInput: true, input: 'redirect-url' })
    expect(flow).toBe('paste-address')
    expect(signInSteps('Antigravity', flow, 'code')[1].title).toBe('Paste the address of the page you end on')
    expect(signInCodeFlowOf({ verificationUrl: 'https://x', requiresCodeInput: true })).toBe('paste')
    expect(signInCodeFlowOf({ verificationUrl: 'https://x', requiresCodeInput: false, userCode: 'AB-12' })).toBe('enter')
  })
})
