import { describe, expect, test } from 'bun:test'
import { signInCodeFlow, signInLead, signInSteps } from '@solus/client-core/sign-in-steps'

// A Claude or Codex sign-in is two steps a person who is not a developer can
// follow: open the provider's page, then move a short code across. Every client
// (the desktop and web card, Settings, onboarding, and the phone sheet) reads
// these words, so they must show where the person is and what comes next.

describe('sign-in steps', () => {
  test('before the page opens, opening it is the one current step', () => {
    const [open, code] = signInSteps('Claude', 'paste', 'start')
    expect(open).toMatchObject({ title: 'Open Claude and sign in', state: 'current' })
    expect(code.state).toBe('next')
  })

  test('once the page is open, the code is the current step and opening is done', () => {
    const [open, code] = signInSteps('Claude', 'paste', 'code')
    expect(open.state).toBe('done')
    expect(code).toMatchObject({ title: 'Paste the code Claude shows you', state: 'current' })
  })

  test('a pasted code shows that it is being checked, so the person does not paste it again', () => {
    expect(signInSteps('Claude', 'paste', 'checking')[1]).toMatchObject({ title: 'Checking your code…', state: 'current' })
  })

  test('Codex asks the person to enter a code on its page, never to paste one back', () => {
    // WHY: Codex runs a device-code login. Asking for a pasted code would send
    // the person looking for a code its page never shows.
    expect(signInCodeFlow('codex')).toBe('enter')
    expect(signInCodeFlow('claude-code')).toBe('paste')
    for (const phase of ['start', 'code', 'checking'] as const) {
      for (const step of signInSteps('Codex', 'enter', phase)) expect(step.title).not.toMatch(/paste/i)
    }
    expect(signInLead('Codex', 'enter')).not.toMatch(/paste/i)
  })

  test('the words never use developer terms', () => {
    const words = (['paste', 'enter'] as const).flatMap((flow) => [
      signInLead('Claude', flow),
      ...(['start', 'code', 'checking'] as const).flatMap((phase) =>
        signInSteps('Claude', flow, phase).flatMap((step) => [step.title, step.hint ?? ''])),
    ])
    for (const text of words) expect(text).not.toMatch(/\b(host|seat|token|CLI|OAuth|connector|turn)\b/i)
  })
})
